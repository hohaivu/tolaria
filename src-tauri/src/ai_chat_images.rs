use base64::Engine;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const AI_CHAT_IMAGE_MAX_BYTES: u64 = 15 * 1024 * 1024;
const ALLOWED_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
pub(crate) const ERROR_UNSUPPORTED_TYPE: &str = "unsupported_type";
pub(crate) const ERROR_TOO_LARGE: &str = "too_large";

const TOLARIA_DIR: &str = ".tolaria";
const TMP_SUBDIR: &str = "tmp";
const GIT_EXCLUDE_ENTRY: &str = ".tolaria/";
const ATTACHED_IMAGES_HEADER: &str = "Attached images (open each file with your file-read tool):";

static LAST_STAGE_MILLIS: AtomicU64 = AtomicU64::new(0);

/// Returns the `<vault>/.tolaria/tmp` directory path for staged AI chat images.
pub(crate) fn ai_chat_tmp_dir(vault_path: &str) -> PathBuf {
    Path::new(vault_path).join(TOLARIA_DIR).join(TMP_SUBDIR)
}

fn next_stage_millis() -> u64 {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0);
    let mut chosen = now_ms;
    let _ = LAST_STAGE_MILLIS.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |prev| {
        chosen = now_ms.max(prev.saturating_add(1));
        Some(chosen)
    });
    chosen
}

fn validate_image_extension(path: &Path) -> Result<(), String> {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| ERROR_UNSUPPORTED_TYPE.to_string())?;
    if ALLOWED_IMAGE_EXTENSIONS
        .iter()
        .any(|allowed| ext.eq_ignore_ascii_case(allowed))
    {
        Ok(())
    } else {
        Err(ERROR_UNSUPPORTED_TYPE.to_string())
    }
}

fn validate_image_size(size_bytes: u64) -> Result<(), String> {
    if size_bytes > AI_CHAT_IMAGE_MAX_BYTES {
        Err(ERROR_TOO_LARGE.to_string())
    } else {
        Ok(())
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

    let info_dir = git_dir.join("info");
    fs::create_dir_all(&info_dir)
        .map_err(|error| format!("Failed to create .git/info directory: {error}"))?;

    let exclude_path = info_dir.join("exclude");
    let existing = match fs::read_to_string(&exclude_path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("Failed to read .git/info/exclude: {error}")),
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

fn prepare_staging_target(vault_path: &str, filename: &str) -> Result<PathBuf, String> {
    let tmp_dir = ai_chat_tmp_dir(vault_path);
    fs::create_dir_all(&tmp_dir)
        .map_err(|error| format!("Failed to create AI chat temp directory: {error}"))?;
    ensure_git_info_exclude(Path::new(vault_path))?;

    let basename = Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(filename);
    let sanitized = crate::vault::sanitize_filename(basename);
    let unique_name = format!("{}-{sanitized}", next_stage_millis());
    Ok(tmp_dir.join(unique_name))
}

/// Decodes and validates a base64 image payload, then stages it inside `<vault>/.tolaria/tmp/`.
pub fn stage_ai_chat_image(
    vault_path: &str,
    filename: &str,
    data_base64: &str,
) -> Result<String, String> {
    validate_image_extension(Path::new(filename))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("Invalid base64 data: {error}"))?;
    validate_image_size(bytes.len() as u64)?;

    let target_path = prepare_staging_target(vault_path, filename)?;
    fs::write(&target_path, bytes)
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
    fs::copy(source, &target_path)
        .map_err(|error| format!("Failed to copy staged image: {error}"))?;
    Ok(target_path.to_string_lossy().into_owned())
}

/// Deletes staged image files that reside directly inside canonical `<vault>/.tolaria/tmp`.
/// Missing paths and paths outside that directory are silently skipped.
pub fn delete_ai_chat_images(vault_path: &str, paths: &[String]) -> Result<(), String> {
    let Ok(canonical_tmp_dir) = fs::canonicalize(ai_chat_tmp_dir(vault_path)) else {
        return Ok(());
    };

    for raw_path in paths {
        let Ok(canonical_path) = fs::canonicalize(Path::new(raw_path)) else {
            continue;
        };
        if canonical_path.is_file()
            && canonical_path.parent() == Some(canonical_tmp_dir.as_path())
        {
            match fs::remove_file(&canonical_path) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("Failed to delete staged image: {error}"));
                }
            }
        }
    }

    Ok(())
}

/// Removes all files inside `<vault>/.tolaria/tmp`. No-op if the directory does not exist.
pub fn clear_ai_chat_images(vault_path: &str) -> Result<(), String> {
    let tmp_dir = ai_chat_tmp_dir(vault_path);
    if !tmp_dir.exists() {
        return Ok(());
    }

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
            match fs::remove_file(entry.path()) {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!("Failed to clear staged image: {error}"));
                }
            }
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

    let canonical_tmp_dir = fs::canonicalize(ai_chat_tmp_dir(vault_path))
        .map_err(|_| "Staged image directory does not exist in vault".to_string())?;

    let mut validated = Vec::with_capacity(attachments.len());
    for raw_path in attachments {
        let canonical_path = fs::canonicalize(Path::new(raw_path))
            .map_err(|_| format!("Attached image does not exist: {raw_path}"))?;
        if !canonical_path.is_file()
            || canonical_path.parent() != Some(canonical_tmp_dir.as_path())
        {
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

    if message.contains(&block) {
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
