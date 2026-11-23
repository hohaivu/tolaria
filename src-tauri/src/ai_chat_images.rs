use crate::vault::{
    decode_base64_image, has_allowed_image_extension, unique_image_path, MAX_IMAGE_BYTES,
};
use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};

const ALLOWED_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
pub(crate) const ERROR_UNSUPPORTED_TYPE: &str = "unsupported_type";
pub(crate) const ERROR_TOO_LARGE: &str = "too_large";

const TOLARIA_DIR: &str = ".tolaria";
const TMP_SUBDIR: &str = "tmp";
const GIT_EXCLUDE_ENTRY: &str = ".tolaria/";
const ATTACHED_IMAGES_HEADER: &str = "Attached images (open each file with your file-read tool):";

/// Returns the `<vault>/.tolaria/tmp` directory path for staged AI chat images.
#[cfg(test)]
pub(crate) fn ai_chat_tmp_dir(vault_path: &str) -> PathBuf {
    Path::new(vault_path).join(TOLARIA_DIR).join(TMP_SUBDIR)
}

fn validate_image_extension(path: &Path) -> Result<(), String> {
    if has_allowed_image_extension(path, ALLOWED_IMAGE_EXTENSIONS) {
        Ok(())
    } else {
        Err(ERROR_UNSUPPORTED_TYPE.to_string())
    }
}

fn validate_image_size(size_bytes: u64) -> Result<(), String> {
    if size_bytes > MAX_IMAGE_BYTES {
        Err(ERROR_TOO_LARGE.to_string())
    } else {
        Ok(())
    }
}

fn is_staged_file_in_tmp_dir(canonical_path: &Path, canonical_tmp_dir: &Path) -> bool {
    canonical_path.is_file() && canonical_path.parent() == Some(canonical_tmp_dir)
}

fn remove_file_if_present(path: &Path, err_context: &str) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("{err_context}: {error}")),
    }
}

/// Returns the real `<vault>/.tolaria/tmp` directory, refusing links on either component so staging,
/// prompt validation, cleanup and asset scoping can never leave the vault. `Ok(None)` means it is
/// missing and `create` is false.
fn confined_tmp_dir(vault_path: &str, create: bool) -> Result<Option<PathBuf>, String> {
    let mut dir = PathBuf::from(vault_path);
    for component in [TOLARIA_DIR, TMP_SUBDIR] {
        dir.push(component);
        match fs::symlink_metadata(&dir) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Err(format!("{} must be a real directory, not a link", dir.display())),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                if !create {
                    return Ok(None);
                }
                fs::create_dir(&dir)
                    .map_err(|error| format!("Failed to create AI chat temp directory: {error}"))?;
            }
            Err(error) => return Err(format!("Failed to inspect AI chat temp directory: {error}")),
        }
    }
    Ok(Some(dir))
}

fn is_real_entry(path: &Path, want_dir: bool) -> Result<Option<bool>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let file_type = metadata.file_type();
            Ok(Some(if want_dir { file_type.is_dir() } else { file_type.is_file() }))
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to inspect {}: {error}", path.display())),
    }
}

fn ensure_git_info_exclude(vault_dir: &Path) -> Result<(), String> {
    let git_dir = vault_dir.join(".git");
    let Ok(metadata) = fs::symlink_metadata(&git_dir) else {
        return Ok(());
    };
    if !metadata.file_type().is_dir() {
        return Ok(());
    }

    // A linked `info` or `exclude` could redirect the write (e.g. onto `.gitignore`): skip, like a linked `.git`.
    let info_dir = git_dir.join("info");
    match is_real_entry(&info_dir, true)? {
        Some(true) => {}
        Some(false) => return Ok(()),
        None => fs::create_dir(&info_dir)
            .map_err(|error| format!("Failed to create .git/info directory: {error}"))?,
    }

    let exclude_path = info_dir.join("exclude");
    let existing = match is_real_entry(&exclude_path, false)? {
        Some(true) => fs::read_to_string(&exclude_path)
            .map_err(|error| format!("Failed to read .git/info/exclude: {error}"))?,
        Some(false) => return Ok(()),
        None => String::new(),
    };

    if existing.lines().any(|line| line == GIT_EXCLUDE_ENTRY) {
        return Ok(());
    }

    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(GIT_EXCLUDE_ENTRY);
    updated.push('\n');

    fs::write(&exclude_path, updated)
        .map_err(|error| format!("Failed to update .git/info/exclude: {error}"))
}

/// `create_new` refuses an existing destination, including a planted symlink.
fn create_staged_file(path: &Path) -> io::Result<fs::File> {
    fs::OpenOptions::new().write(true).create_new(true).open(path)
}

fn prepare_staging_target(vault_path: &str, filename: &str) -> Result<PathBuf, String> {
    let tmp_dir = confined_tmp_dir(vault_path, true)?
        .ok_or_else(|| "Failed to create AI chat temp directory".to_string())?;
    ensure_git_info_exclude(Path::new(vault_path))?;
    Ok(unique_image_path(&tmp_dir, filename))
}

/// Decodes and validates a base64 image payload, then stages it inside `<vault>/.tolaria/tmp/`.
pub fn stage_ai_chat_image(
    vault_path: &str,
    filename: &str,
    data_base64: &str,
) -> Result<String, String> {
    validate_image_extension(Path::new(filename))?;
    let bytes = decode_base64_image(data_base64)?;
    validate_image_size(bytes.len() as u64)?;

    let target_path = prepare_staging_target(vault_path, filename)?;
    create_staged_file(&target_path)
        .and_then(|mut file| file.write_all(&bytes))
        .map_err(|error| format!("Failed to write staged image: {error}"))?;
    Ok(target_path.to_string_lossy().into_owned())
}

/// Validates and copies an image file on disk into `<vault>/.tolaria/tmp/`.
pub fn stage_ai_chat_image_from_path(vault_path: &str, source_path: &str) -> Result<String, String> {
    let source = Path::new(source_path);
    validate_image_extension(source)?;

    let metadata = fs::metadata(source)
        .map_err(|_| format!("Source file does not exist: {source_path}"))?;
    if !metadata.is_file() {
        return Err(format!("Source path is not a file: {source_path}"));
    }
    validate_image_size(metadata.len())?;

    let filename = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image");
    let target_path = prepare_staging_target(vault_path, filename)?;
    fs::File::open(source)
        .and_then(|mut input| {
            let mut output = create_staged_file(&target_path)?;
            io::copy(&mut input, &mut output)
        })
        .map_err(|error| format!("Failed to copy staged image: {error}"))?;
    Ok(target_path.to_string_lossy().into_owned())
}

/// Deletes staged image files that reside directly inside canonical `<vault>/.tolaria/tmp`.
/// Missing paths and paths outside that directory are silently skipped.
pub fn delete_ai_chat_images(vault_path: &str, paths: &[String]) -> Result<(), String> {
    let Some(tmp_dir) = confined_tmp_dir(vault_path, false)? else {
        return Ok(());
    };
    let Ok(canonical_tmp_dir) = fs::canonicalize(tmp_dir) else {
        return Ok(());
    };

    for raw_path in paths {
        let Ok(canonical_path) = fs::canonicalize(Path::new(raw_path)) else {
            continue;
        };
        if is_staged_file_in_tmp_dir(&canonical_path, &canonical_tmp_dir) {
            remove_file_if_present(&canonical_path, "Failed to delete staged image")?;
        }
    }

    Ok(())
}

/// Removes all files inside `<vault>/.tolaria/tmp`. No-op if the directory does not exist.
pub fn clear_ai_chat_images(vault_path: &str) -> Result<(), String> {
    let Some(tmp_dir) = confined_tmp_dir(vault_path, false)? else {
        return Ok(());
    };

    let canonical_tmp_dir = fs::canonicalize(&tmp_dir)
        .map_err(|error| format!("Failed to resolve AI chat temp directory: {error}"))?;
    let entries = fs::read_dir(&canonical_tmp_dir)
        .map_err(|error| format!("Failed to read AI chat temp directory: {error}"))?;

    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Failed to inspect AI chat temp entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Failed to inspect AI chat temp entry type: {error}"))?;
        if file_type.is_file() || file_type.is_symlink() {
            remove_file_if_present(&entry.path(), "Failed to clear staged image")?;
        }
    }

    Ok(())
}

/// Validates that every attachment resolves to an existing regular file directly inside canonical `<vault>/.tolaria/tmp`.
pub(crate) fn validate_staged_attachments(
    vault_path: &str,
    attachments: &[String],
) -> Result<Vec<String>, String> {
    if attachments.is_empty() {
        return Ok(Vec::new());
    }

    let canonical_tmp_dir = confined_tmp_dir(vault_path, false)?
        .and_then(|tmp_dir| fs::canonicalize(tmp_dir).ok())
        .ok_or_else(|| "Staged image directory does not exist in vault".to_string())?;

    let mut validated = Vec::with_capacity(attachments.len());
    for raw_path in attachments {
        let canonical_path = fs::canonicalize(Path::new(raw_path))
            .map_err(|_| format!("Attached image does not exist: {raw_path}"))?;
        if !is_staged_file_in_tmp_dir(&canonical_path, &canonical_tmp_dir) {
            return Err(format!(
                "Attached image must be inside .tolaria/tmp: {raw_path}"
            ));
        }
        validated.push(canonical_path.to_string_lossy().into_owned());
    }

    Ok(validated)
}

/// Appends validated staged attachment paths to a prompt idempotently.
pub(crate) fn append_attachments_to_message(message: &str, validated_paths: &[String]) -> String {
    if validated_paths.is_empty() {
        return message.to_string();
    }

    let mut block = String::from(ATTACHED_IMAGES_HEADER);
    for path in validated_paths {
        block.push_str("\n- ");
        block.push_str(path);
    }

    // Only a whole block counts: a longer filename sharing the prefix must not satisfy it.
    let has_block = message.match_indices(&block).any(|(start, _)| {
        let end = start + block.len();
        (start == 0 || message.as_bytes()[start - 1] == b'\n')
            && (end == message.len() || message.as_bytes()[end] == b'\n')
    });
    if has_block {
        return message.to_string();
    }
    if message.trim().is_empty() {
        return block;
    }

    format!("{message}\n\n{block}")
}

#[cfg(test)]
#[path = "ai_chat_images_tests.rs"]
mod tests;
