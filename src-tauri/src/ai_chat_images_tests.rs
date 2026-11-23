use super::*;
use crate::ai_agents::{run_ai_agent_stream, AiAgentId, AiAgentPermissionMode, AiAgentStreamEvent, AiAgentStreamRequest};
use base64::Engine;
use std::process::Command;
use tempfile::TempDir;

fn make_solid_red_png_64x64() -> Vec<u8> {
    let width = 64u32;
    let height = 64u32;
    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
    for _ in 0..(width * height) {
        rgb.extend_from_slice(&[255, 0, 0]);
    }
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, width, height);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().unwrap();
    writer.write_image_data(&rgb).unwrap();
    drop(writer);
    bytes
}

fn encode_base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn init_git_repo(dir: &Path) {
    let output = Command::new("git")
        .args(["init"])
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git init failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn stage_base64_round_trip_writes_to_dot_tolaria_tmp() {
    let vault = TempDir::new().unwrap();
    let vault_path = vault.path().to_string_lossy().into_owned();
    let raw = make_solid_red_png_64x64();
    let b64 = encode_base64(&raw);

    let staged = stage_ai_chat_image(&vault_path, "my photo (1).png", &b64).unwrap();
    let staged_path = Path::new(&staged);

    assert!(staged_path.exists());
    assert_eq!(
        staged_path.parent().unwrap(),
        vault.path().join(".tolaria").join("tmp")
    );
    let file_name = staged_path.file_name().unwrap().to_string_lossy();
    let (millis, rest) = file_name.split_once('-').unwrap();
    assert!(millis.chars().all(|c| c.is_ascii_digit()) && !millis.is_empty());
    assert!(
        millis.parse::<u64>().unwrap() > 1_000_000_000_000,
        "expected epoch milliseconds, got {millis}"
    );
    assert_eq!(rest, "my_photo__1_.png");
    assert_eq!(fs::read(staged_path).unwrap(), raw);
}

#[test]
fn rapid_staging_calls_produce_distinct_filenames() {
    let vault = TempDir::new().unwrap();
    let vault_path = vault.path().to_string_lossy().into_owned();
    let b64 = encode_base64(b"pngdata");

    let first = stage_ai_chat_image(&vault_path, "shot.png", &b64).unwrap();
    let second = stage_ai_chat_image(&vault_path, "shot.png", &b64).unwrap();

    assert_ne!(first, second);
    assert!(Path::new(&first).exists());
    assert!(Path::new(&second).exists());
}

#[test]
fn stage_from_path_round_trip_and_missing_or_directory_errors() {
    let vault = TempDir::new().unwrap();
    let source_dir = TempDir::new().unwrap();
    let vault_path = vault.path().to_string_lossy().into_owned();
    let raw = make_solid_red_png_64x64();
    let src = source_dir.path().join("diagram.WebP");
    fs::write(&src, &raw).unwrap();

    let staged = stage_ai_chat_image_from_path(&vault_path, src.to_str().unwrap()).unwrap();
    assert_eq!(fs::read(&staged).unwrap(), raw);
    assert!(staged.ends_with("-diagram.WebP"));

    let missing_err =
        stage_ai_chat_image_from_path(&vault_path, source_dir.path().join("missing.png").to_str().unwrap())
            .unwrap_err();
    assert!(missing_err.contains("does not exist"));

    let dir_src = source_dir.path().join("folder.png");
    fs::create_dir(&dir_src).unwrap();
    let dir_err =
        stage_ai_chat_image_from_path(&vault_path, dir_src.to_str().unwrap()).unwrap_err();
    assert!(dir_err.contains("not a file"));
}

#[test]
fn validation_accepts_allowed_extensions_case_insensitively_on_both_entry_points() {
    let vault = TempDir::new().unwrap();
    let source_dir = TempDir::new().unwrap();
    let vault_path = vault.path().to_string_lossy().into_owned();
    let b64 = encode_base64(b"img-bytes");

    for ext in ["png", "PNG", "jpg", "JPG", "jpeg", "Jpeg", "gif", "GIF", "webp", "WebP"] {
        let name = format!("sample.{ext}");
        let staged_b64 = stage_ai_chat_image(&vault_path, &name, &b64);
        assert!(staged_b64.is_ok(), "base64 rejected {ext}: {staged_b64:?}");

        let src = source_dir.path().join(&name);
        fs::write(&src, b"img-bytes").unwrap();
        let staged_path = stage_ai_chat_image_from_path(&vault_path, src.to_str().unwrap());
        assert!(staged_path.is_ok(), "from_path rejected {ext}: {staged_path:?}");
    }
}

#[test]
fn validation_rejects_unsupported_extensions_and_oversized_images_without_writing() {
    let vault = TempDir::new().unwrap();
    let source_dir = TempDir::new().unwrap();
    let vault_path = vault.path().to_string_lossy().into_owned();
    let b64 = encode_base64(b"bad-bytes");

    for bad_name in [
        "photo.heic",
        "photo.HEIF",
        "vector.svg",
        "bitmap.bmp",
        "scan.tiff",
        "doc.pdf",
        "noext",
    ] {
        let err = stage_ai_chat_image(&vault_path, bad_name, &b64).unwrap_err();
        assert_eq!(err, ERROR_UNSUPPORTED_TYPE, "for {bad_name}");

        let src = source_dir.path().join(bad_name);
        fs::write(&src, b"bad-bytes").unwrap();
        let path_err = stage_ai_chat_image_from_path(&vault_path, src.to_str().unwrap()).unwrap_err();
        assert_eq!(path_err, ERROR_UNSUPPORTED_TYPE, "from_path for {bad_name}");
    }

    assert!(!vault.path().join(".tolaria").exists());

    let max_bytes = vec![0x42u8; MAX_IMAGE_BYTES as usize];
    let ok_src = source_dir.path().join("exact_limit.png");
    fs::write(&ok_src, &max_bytes).unwrap();
    assert!(stage_ai_chat_image_from_path(&vault_path, ok_src.to_str().unwrap()).is_ok());
    assert!(stage_ai_chat_image(&vault_path, "exact_limit.png", &encode_base64(&max_bytes)).is_ok());

    clear_ai_chat_images(&vault_path).unwrap();

    let too_large_bytes = vec![0x42u8; (MAX_IMAGE_BYTES + 1) as usize];
    let over_err =
        stage_ai_chat_image(&vault_path, "too_big.png", &encode_base64(&too_large_bytes))
            .unwrap_err();
    assert_eq!(over_err, ERROR_TOO_LARGE);

    let bad_src = source_dir.path().join("too_big.jpg");
    fs::write(&bad_src, &too_large_bytes).unwrap();
    let over_path_err =
        stage_ai_chat_image_from_path(&vault_path, bad_src.to_str().unwrap()).unwrap_err();
    assert_eq!(over_path_err, ERROR_TOO_LARGE);

    let remaining: Vec<_> = fs::read_dir(ai_chat_tmp_dir(&vault_path))
        .unwrap()
        .collect();
    assert!(remaining.is_empty());
}

#[test]
fn staging_adds_tolaria_exclude_once_without_touching_gitignore() {
    let vault = TempDir::new().unwrap();
    init_git_repo(vault.path());
    let info_dir = vault.path().join(".git").join("info");
    let exclude_path = info_dir.join("exclude");
    fs::create_dir_all(&info_dir).unwrap();
    fs::write(&exclude_path, "*.log").unwrap();

    let vault_path = vault.path().to_string_lossy().into_owned();
    let b64 = encode_base64(b"img");

    stage_ai_chat_image(&vault_path, "one.png", &b64).unwrap();
    stage_ai_chat_image(&vault_path, "two.png", &b64).unwrap();

    let exclude = fs::read_to_string(&exclude_path).unwrap();
    assert_eq!(exclude, "*.log\n.tolaria/\n");
    assert_eq!(
        exclude.lines().filter(|line| *line == ".tolaria/").count(),
        1
    );
    assert!(!vault.path().join(".gitignore").exists());
}

#[test]
fn staging_creates_missing_git_info_exclude_and_preserves_existing_gitignore() {
    let vault = TempDir::new().unwrap();
    fs::create_dir(vault.path().join(".git")).unwrap();
    fs::write(vault.path().join(".gitignore"), "custom/\n").unwrap();

    let vault_path = vault.path().to_string_lossy().into_owned();
    stage_ai_chat_image(&vault_path, "one.png", &encode_base64(b"img")).unwrap();

    let exclude = fs::read_to_string(vault.path().join(".git/info/exclude")).unwrap();
    assert_eq!(exclude, ".tolaria/\n");
    assert_eq!(
        fs::read_to_string(vault.path().join(".gitignore")).unwrap(),
        "custom/\n"
    );
}

#[test]
fn staging_skips_git_exclude_when_git_missing_or_file() {
    let no_git_vault = TempDir::new().unwrap();
    let no_git_path = no_git_vault.path().to_string_lossy().into_owned();
    stage_ai_chat_image(&no_git_path, "one.png", &encode_base64(b"img")).unwrap();
    assert!(!no_git_vault.path().join(".git").exists());

    let file_git_vault = TempDir::new().unwrap();
    fs::write(file_git_vault.path().join(".git"), "gitdir: ../elsewhere\n").unwrap();
    let file_git_path = file_git_vault.path().to_string_lossy().into_owned();
    stage_ai_chat_image(&file_git_path, "one.png", &encode_base64(b"img")).unwrap();
    assert!(file_git_vault.path().join(".git").is_file());
    assert!(!file_git_vault.path().join(".git/info/exclude").exists());
}

#[cfg(unix)]
#[test]
fn staging_skips_git_exclude_when_git_is_symlink() {
    let vault = TempDir::new().unwrap();
    let external = TempDir::new().unwrap();
    std::os::unix::fs::symlink(external.path(), vault.path().join(".git")).unwrap();

    let vault_path = vault.path().to_string_lossy().into_owned();
    stage_ai_chat_image(&vault_path, "one.png", &encode_base64(b"img")).unwrap();

    assert!(!external.path().join("info/exclude").exists());
}

#[test]
fn delete_and_clear_only_remove_files_inside_tolaria_tmp() {
    let vault = TempDir::new().unwrap();
    let outside_dir = TempDir::new().unwrap();
    let vault_path = vault.path().to_string_lossy().into_owned();

    // Clearing before folder exists is a no-op
    clear_ai_chat_images(&vault_path).unwrap();

    let outside_file = outside_dir.path().join("keep.png");
    fs::write(&outside_file, b"keep-outside").unwrap();
    let vault_root_file = vault.path().join("note-img.png");
    fs::write(&vault_root_file, b"keep-vault-root").unwrap();

    let first = stage_ai_chat_image(&vault_path, "a.png", &encode_base64(b"a")).unwrap();
    let second = stage_ai_chat_image(&vault_path, "b.png", &encode_base64(b"b")).unwrap();
    let traversal = ai_chat_tmp_dir(&vault_path)
        .join("..")
        .join("..")
        .join("note-img.png")
        .to_string_lossy()
        .into_owned();

    #[cfg(unix)]
    let escaping_symlink = {
        let link = ai_chat_tmp_dir(&vault_path).join("escape-link.png");
        std::os::unix::fs::symlink(&outside_file, &link).unwrap();
        link.to_string_lossy().into_owned()
    };

    let mut targets = vec![
        first.clone(),
        ai_chat_tmp_dir(&vault_path)
            .join("missing.png")
            .to_string_lossy()
            .into_owned(),
        outside_file.to_string_lossy().into_owned(),
        traversal,
    ];
    #[cfg(unix)]
    targets.push(escaping_symlink);

    delete_ai_chat_images(&vault_path, &targets).unwrap();

    assert!(!Path::new(&first).exists());
    assert!(Path::new(&second).exists());
    assert!(outside_file.exists());
    assert!(vault_root_file.exists());

    clear_ai_chat_images(&vault_path).unwrap();
    assert!(!Path::new(&second).exists());
    assert!(outside_file.exists());
    assert!(vault_root_file.exists());
}

#[test]
fn validate_staged_attachments_rejects_outside_traversal_missing_and_symlinks() {
    let vault = TempDir::new().unwrap();
    let outside_dir = TempDir::new().unwrap();
    let vault_path = vault.path().to_string_lossy().into_owned();

    let outside_file = outside_dir.path().join("secret.png");
    fs::write(&outside_file, b"secret").unwrap();
    let vault_file = vault.path().join("root.png");
    fs::write(&vault_file, b"root").unwrap();

    let first = stage_ai_chat_image(&vault_path, "first.png", &encode_base64(b"1")).unwrap();
    let second = stage_ai_chat_image(&vault_path, "second.png", &encode_base64(b"2")).unwrap();

    let valid = validate_staged_attachments(&vault_path, &[second.clone(), first.clone()]).unwrap();
    assert_eq!(valid.len(), 2);
    assert_eq!(valid[0], fs::canonicalize(&second).unwrap().to_string_lossy());
    assert_eq!(valid[1], fs::canonicalize(&first).unwrap().to_string_lossy());

    assert!(validate_staged_attachments(&vault_path, &[outside_file.to_string_lossy().into_owned()]).is_err());
    assert!(validate_staged_attachments(&vault_path, &[vault_file.to_string_lossy().into_owned()]).is_err());
    assert!(
        validate_staged_attachments(
            &vault_path,
            &[ai_chat_tmp_dir(&vault_path)
                .join("..")
                .join("..")
                .join("root.png")
                .to_string_lossy()
                .into_owned()],
        )
        .is_err()
    );
    assert!(
        validate_staged_attachments(
            &vault_path,
            &[ai_chat_tmp_dir(&vault_path)
                .join("does-not-exist.png")
                .to_string_lossy()
                .into_owned()],
        )
        .is_err()
    );

    #[cfg(unix)]
    {
        let link = ai_chat_tmp_dir(&vault_path).join("link-out.png");
        std::os::unix::fs::symlink(&outside_file, &link).unwrap();
        assert!(validate_staged_attachments(&vault_path, &[link.to_string_lossy().into_owned()]).is_err());
    }
}

#[cfg(unix)]
fn link_tolaria_tmp(vault: &Path, outside: &Path, link_tolaria: bool) {
    if link_tolaria {
        std::os::unix::fs::symlink(outside, vault.join(".tolaria")).unwrap();
    } else {
        fs::create_dir(vault.join(".tolaria")).unwrap();
        std::os::unix::fs::symlink(outside, vault.join(".tolaria/tmp")).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn linked_tolaria_or_tmp_directory_is_refused_by_every_operation() {
    for link_tolaria in [true, false] {
        let vault = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let vault_path = vault.path().to_string_lossy().into_owned();
        let source = TempDir::new().unwrap();
        let source_file = source.path().join("src.png");
        fs::write(&source_file, b"src").unwrap();
        // The outside directory plays `.tolaria` (holding a `tmp` dir) or `tmp` itself.
        let outside_files_dir = if link_tolaria {
            fs::create_dir(outside.path().join("tmp")).unwrap();
            outside.path().join("tmp")
        } else {
            outside.path().to_path_buf()
        };
        let outside_file = outside_files_dir.join("keep.png");
        fs::write(&outside_file, b"keep").unwrap();
        link_tolaria_tmp(vault.path(), outside.path(), link_tolaria);
        let outside_arg = outside_file.to_string_lossy().into_owned();

        assert!(stage_ai_chat_image(&vault_path, "a.png", &encode_base64(b"a")).is_err());
        assert!(stage_ai_chat_image_from_path(&vault_path, source_file.to_str().unwrap()).is_err());
        assert!(validate_staged_attachments(&vault_path, std::slice::from_ref(&outside_arg)).is_err());
        assert!(delete_ai_chat_images(&vault_path, &[outside_arg]).is_err());
        assert!(clear_ai_chat_images(&vault_path).is_err());

        let names: Vec<_> = fs::read_dir(&outside_files_dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("keep.png")]);
        assert_eq!(fs::read(&outside_file).unwrap(), b"keep");
    }
}

#[cfg(unix)]
#[test]
fn linked_git_exclude_or_info_never_redirects_the_exclude_write() {
    // `exclude` -> .gitignore
    let vault = TempDir::new().unwrap();
    fs::create_dir_all(vault.path().join(".git/info")).unwrap();
    fs::write(vault.path().join(".gitignore"), "custom/\n").unwrap();
    std::os::unix::fs::symlink(vault.path().join(".gitignore"), vault.path().join(".git/info/exclude")).unwrap();
    let vault_path = vault.path().to_string_lossy().into_owned();
    stage_ai_chat_image(&vault_path, "one.png", &encode_base64(b"img")).unwrap();
    assert_eq!(fs::read_to_string(vault.path().join(".gitignore")).unwrap(), "custom/\n");

    // `info` -> outside directory
    let vault = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    fs::create_dir(vault.path().join(".git")).unwrap();
    std::os::unix::fs::symlink(outside.path(), vault.path().join(".git/info")).unwrap();
    let vault_path = vault.path().to_string_lossy().into_owned();
    stage_ai_chat_image(&vault_path, "one.png", &encode_base64(b"img")).unwrap();
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn staging_never_writes_through_a_planted_leaf_symlink() {
    let vault = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let vault_path = vault.path().to_string_lossy().into_owned();
    let target = unique_image_path(&confined_tmp_dir(&vault_path, true).unwrap().unwrap(), "p.png");
    let outside_file = outside.path().join("victim.png");
    fs::write(&outside_file, b"victim").unwrap();
    std::os::unix::fs::symlink(&outside_file, &target).unwrap();

    assert!(create_staged_file(&target).is_err());
    assert_eq!(fs::read(&outside_file).unwrap(), b"victim");
}

#[test]
fn append_attachments_to_message_handles_empty_order_and_idempotency() {
    let paths = vec![
        "/vault/.tolaria/tmp/1-a.png".to_string(),
        "/vault/.tolaria/tmp/2-b.jpg".to_string(),
    ];

    assert_eq!(append_attachments_to_message("hello", &[]), "hello");

    let empty_msg = append_attachments_to_message("   ", &paths);
    assert_eq!(
        empty_msg,
        "Attached images (open each file with your file-read tool):\n- /vault/.tolaria/tmp/1-a.png\n- /vault/.tolaria/tmp/2-b.jpg"
    );

    let with_text = append_attachments_to_message("Describe these", &paths);
    assert_eq!(
        with_text,
        "Describe these\n\nAttached images (open each file with your file-read tool):\n- /vault/.tolaria/tmp/1-a.png\n- /vault/.tolaria/tmp/2-b.jpg"
    );

    // Calling again is idempotent
    assert_eq!(append_attachments_to_message(&with_text, &paths), with_text);
}

fn run_real_agent_image_check(agent: AiAgentId, label: &str) -> (Result<String, String>, String, Vec<String>) {
    let vault = TempDir::new().unwrap();
    init_git_repo(vault.path());
    let vault_path = vault.path().to_string_lossy().into_owned();
    let staged_path = stage_ai_chat_image(
        &vault_path,
        "red.png",
        &encode_base64(&make_solid_red_png_64x64()),
    )
    .unwrap();

    let exclude = fs::read_to_string(vault.path().join(".git/info/exclude")).unwrap();
    assert!(exclude.lines().any(|line| line == ".tolaria/"));

    let mut events_log = Vec::new();
    let mut final_text = String::new();
    let result = run_ai_agent_stream(
        AiAgentStreamRequest {
            agent,
            model: None,
            message: "What single colour fills the attached image? Answer with one word.".into(),
            system_prompt: None,
            vault_path,
            vault_paths: Vec::new(),
            permission_mode: Some(AiAgentPermissionMode::Safe),
            event_name: None,
            attachments: vec![staged_path],
        },
        |event| {
            println!("[{label}] {event:?}");
            events_log.push(format!("{event:?}"));
            if let AiAgentStreamEvent::TextDelta { text } = event {
                final_text.push_str(&text);
            }
        },
    );

    println!("[{label}] result={result:?} final_text={final_text:?}");
    (result, final_text, events_log)
}

#[ignore]
#[test]
fn real_claude_reads_staged_image() {
    let (result, final_text, events_log) =
        run_real_agent_image_check(AiAgentId::ClaudeCode, "claude");
    assert!(
        result.is_ok(),
        "real claude stream failed: {result:?}\nevents:\n{}",
        events_log.join("\n")
    );
    assert!(
        final_text.to_ascii_lowercase().contains("red"),
        "expected 'red' in claude output, got {final_text:?}\nevents:\n{}",
        events_log.join("\n")
    );
}

#[ignore]
#[test]
fn real_pi_reads_staged_image() {
    let (result, final_text, events_log) = run_real_agent_image_check(AiAgentId::Pi, "pi");
    assert!(
        result.is_ok(),
        "real pi stream failed: {result:?}\nevents:\n{}",
        events_log.join("\n")
    );
    assert!(
        final_text.to_ascii_lowercase().contains("red"),
        "expected 'red' in pi output, got {final_text:?}\nevents:\n{}",
        events_log.join("\n")
    );
}
