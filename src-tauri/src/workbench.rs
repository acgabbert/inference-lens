use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

pub mod completion;

// Fixed byte contract shared with core, not a second bundle-policy generator.
const IGNORE: &str = "*\n";

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum File {
    Read { path: String, contents: String },
    Unavailable { path: String, error: String },
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Mutation {
    Written,
    Conflict {
        phase: &'static str,
        actual_contents: Option<String>,
    },
    // Refusals before the record is touched: "foreign-project" blocks the whole
    // store, "protection" only this attempt.
    Blocked {
        reason: &'static str,
        message: String,
    },
}

/// The record directories under `.workbench`, each holding one record kind.
const RECORD_DIRECTORIES: [(&str, &str); 2] = [("drafts", "draft_"), ("scratch", "scratch_")];

fn destination(directory: &Path, path: &str) -> Result<PathBuf, String> {
    let safe = path == "selections.json"
        || RECORD_DIRECTORIES.iter().any(|(folder, prefix)| {
            path.strip_prefix(*folder)
                .and_then(|rest| rest.strip_prefix('/'))
                .and_then(|name| name.strip_prefix(*prefix))
                .and_then(|suffix| suffix.strip_suffix(".json"))
                .is_some_and(|suffix| {
                    !suffix.is_empty()
                        && suffix
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
                })
        });
    if !safe {
        return Err("Invalid workbench record path.".into());
    }
    Ok(directory.join(".workbench").join(path))
}

fn reject_link(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "Workbench paths cannot be symlinks: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not inspect {}: {error}", path.display())),
    }
}

fn read(path: &Path) -> Result<Option<String>, String> {
    reject_link(path)?;
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read {}: {error}", path.display())),
    }
}

/// Active records as raw bytes; text decoding is left to the caller.
fn active_records(directory: &Path) -> Result<Vec<ByteFile>, String> {
    let workbench = directory.join(".workbench");
    reject_link(&workbench)?;
    let mut files = Vec::new();
    let parents = std::iter::once((workbench.clone(), String::new())).chain(
        RECORD_DIRECTORIES
            .iter()
            .map(|(folder, _)| (workbench.join(folder), format!("{folder}/"))),
    );
    for (parent, prefix) in parents {
        reject_link(&parent)?;
        let entries = match fs::read_dir(&parent) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Could not list recovery records: {error}")),
        };
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("Could not list a recovery record: {error}"))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".json") {
                continue;
            }
            let path = format!("{prefix}{name}");
            // A directory with a record filename is unavailable, never writable.
            files.push(match read_bytes(&entry.path()) {
                Ok(Some(bytes)) => ByteFile::Read { path, bytes },
                Ok(None) => ByteFile::Unavailable {
                    path,
                    error: "Recovery record disappeared while reading.".into(),
                },
                Err(error) => ByteFile::Unavailable { path, error },
            });
        }
    }
    Ok(files)
}

pub fn list(directory: &Path) -> Result<Vec<File>, String> {
    let mut files: Vec<File> = active_records(directory)?
        .into_iter()
        .map(|file| match file {
            ByteFile::Read { path, bytes } => match String::from_utf8(bytes) {
                Ok(contents) => File::Read { path, contents },
                Err(error) => File::Unavailable {
                    error: format!("Could not read {path}: {error}"),
                    path,
                },
            },
            ByteFile::Unavailable { path, error } => File::Unavailable { path, error },
        })
        .collect();
    for file in migration_files(directory)? {
        // Readable but malformed bytes are unparseable identity, as in the browser host.
        files.push(match file {
            ByteFile::Read { path, bytes } => File::Read {
                path,
                contents: String::from_utf8_lossy(&bytes).into_owned(),
            },
            ByteFile::Unavailable { path, error } => File::Unavailable { path, error },
        });
    }
    files.sort_by(|left, right| {
        let (File::Read { path: a, .. } | File::Unavailable { path: a, .. }) = left;
        let (File::Read { path: b, .. } | File::Unavailable { path: b, .. }) = right;
        a.cmp(b)
    });
    Ok(files)
}

fn foreign(files: &[File], project_id: &str) -> bool {
    files.iter().any(|file| {
        let File::Read { contents, .. } = file else {
            return false;
        };
        serde_json::from_str::<serde_json::Value>(contents.trim_start_matches('\u{feff}'))
            .ok()
            .and_then(|value| value.get("projectId")?.as_str().map(str::to_owned))
            .is_some_and(|id| id != project_id)
    })
}

fn protect(workbench: &Path) -> Result<(), String> {
    let ignore = workbench.join(".gitignore");
    if read(&ignore)?.is_none() {
        // Exclusive creation prevents replacing a policy that appeared meanwhile.
        use std::io::Write;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&ignore)
        {
            Ok(mut file) => file
                .write_all(IGNORE.as_bytes())
                .map_err(|error| format!("Could not protect recovery directory: {error}"))?,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("Could not protect recovery directory: {error}")),
        }
    }
    if read(&ignore)?.as_deref() != Some(IGNORE) {
        return Err("Workbench .gitignore must contain exactly '*\\n' before personal content can be written.".into());
    }
    Ok(())
}

pub fn mutate(
    directory: &Path,
    path: &str,
    expected: Option<&str>,
    contents: Option<&str>,
    project_id: &str,
) -> Result<Mutation, String> {
    mutate_with(directory, path, expected, contents, project_id, || {})
}

// The callback permits deterministic filesystem interference in native tests.
fn mutate_with(
    directory: &Path,
    path: &str,
    expected: Option<&str>,
    contents: Option<&str>,
    project_id: &str,
    after_write: impl FnOnce(),
) -> Result<Mutation, String> {
    let target = destination(directory, path)?;
    let workbench = directory.join(".workbench");
    let inventory = list(directory)?;
    if inventory.iter().any(
        |file| matches!(file, File::Unavailable { path, .. } if path.starts_with("migrations")),
    ) {
        return Err("Migration inventory is unavailable; workbench writes are blocked.".into());
    }
    if foreign(&inventory, project_id) {
        return Ok(Mutation::Blocked {
            reason: "foreign-project",
            message: "Workbench belongs to a different project. Preserve it before reconciling."
                .into(),
        });
    }
    reject_link(&workbench)?;
    fs::create_dir_all(&workbench)
        .map_err(|error| format!("Could not create recovery directory: {error}"))?;
    // Nothing personal has been touched yet, so any failure here is a refusal.
    if let Err(message) = protect(&workbench) {
        return Ok(Mutation::Blocked {
            reason: "protection",
            message,
        });
    }
    for (folder, _) in RECORD_DIRECTORIES {
        reject_link(&workbench.join(folder))?;
    }
    let actual = read(&target)?;
    if actual.as_deref() != expected {
        return Ok(Mutation::Conflict {
            phase: "before-write",
            actual_contents: actual,
        });
    }
    match contents {
        Some(contents) => {
            let parent = target.parent().ok_or("Recovery record has no parent.")?;
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create draft directory: {error}"))?;
            // Keep the previous copy intact if preparing the replacement fails.
            let temporary = parent.join(format!(".recovery-{}.tmp", uuid::Uuid::new_v4()));
            let result =
                fs::write(&temporary, contents).and_then(|()| fs::rename(&temporary, &target));
            if let Err(error) = result {
                let _ = fs::remove_file(&temporary);
                return Err(format!("Could not write recovery record: {error}"));
            }
        }
        None if actual.is_some() => fs::remove_file(&target)
            .map_err(|error| format!("Could not delete recovery record: {error}"))?,
        None => {}
    }
    after_write();
    let confirmed = read(&target)?;
    Ok(if confirmed.as_deref() == contents {
        Mutation::Written
    } else {
        Mutation::Conflict {
            phase: "read-back",
            actual_contents: confirmed,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("inference-lens-recovery-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn seed(&self, path: &str, contents: &str) {
            let path = self.0.join(".workbench").join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn native_recovery_writes_protection_and_checks_expected_bytes() {
        let directory = Directory::new();
        assert!(list(&directory.0).unwrap().is_empty());
        assert!(!directory.0.join(".workbench").exists());
        assert_eq!(
            mutate(
                &directory.0,
                "selections.json",
                None,
                Some("local work"),
                "project_one"
            )
            .unwrap(),
            Mutation::Written
        );
        assert_eq!(
            read(&directory.0.join(".workbench/.gitignore"))
                .unwrap()
                .as_deref(),
            Some("*\n")
        );
        assert_eq!(
            mutate(
                &directory.0,
                "selections.json",
                None,
                Some("overwrite"),
                "project_one"
            )
            .unwrap(),
            Mutation::Conflict {
                phase: "before-write",
                actual_contents: Some("local work".into())
            }
        );
        assert_eq!(
            read(&directory.0.join(".workbench/selections.json"))
                .unwrap()
                .as_deref(),
            Some("local work")
        );
    }

    #[test]
    fn custom_or_unwritable_protection_prevents_personal_content() {
        let directory = Directory::new();
        let save = || {
            mutate(
                &directory.0,
                "selections.json",
                None,
                Some("personal"),
                "project_one",
            )
            .unwrap()
        };
        let refused = |result: Mutation| {
            matches!(
                result,
                Mutation::Blocked {
                    reason: "protection",
                    ..
                }
            )
        };
        directory.seed(".gitignore", "# custom\n");
        assert!(refused(save()));
        assert!(!directory.0.join(".workbench/selections.json").exists());
        assert_eq!(
            read(&directory.0.join(".workbench/.gitignore"))
                .unwrap()
                .as_deref(),
            Some("# custom\n")
        );
        fs::remove_file(directory.0.join(".workbench/.gitignore")).unwrap();
        fs::create_dir(directory.0.join(".workbench/.gitignore")).unwrap();
        assert!(refused(save()));
        assert!(!directory.0.join(".workbench/selections.json").exists());
        // A refusal touches nothing personal, so a fixed policy lets saves resume.
        fs::remove_dir(directory.0.join(".workbench/.gitignore")).unwrap();
        directory.seed(".gitignore", "*\n");
        assert_eq!(save(), Mutation::Written);
    }

    #[test]
    fn unknown_and_corrupt_records_are_preserved_and_foreign_ids_block_all_writes() {
        let directory = Directory::new();
        directory.seed("drafts/draft_broken.json", "{unfinished");
        directory.seed(
            "drafts/draft_future.json",
            "{\"schemaVersion\":99,\"projectId\":\"project_foreign\"}",
        );
        assert_eq!(list(&directory.0).unwrap().len(), 2);
        assert!(matches!(
            mutate(
                &directory.0,
                "selections.json",
                None,
                Some("personal"),
                "project_one"
            )
            .unwrap(),
            Mutation::Blocked { .. }
        ));
        assert!(!directory.0.join(".workbench/.gitignore").exists());
        assert_eq!(
            read(&directory.0.join(".workbench/drafts/draft_broken.json"))
                .unwrap()
                .as_deref(),
            Some("{unfinished")
        );
    }

    #[test]
    fn native_readback_checks_updates_and_deletions() {
        for contents in [Some("new work"), None] {
            let directory = Directory::new();
            directory.seed("selections.json", "old work");
            let result = mutate_with(
                &directory.0,
                "selections.json",
                Some("old work"),
                contents,
                "project_one",
                || directory.seed("selections.json", "external work"),
            )
            .unwrap();
            assert_eq!(
                result,
                Mutation::Conflict {
                    phase: "read-back",
                    actual_contents: Some("external work".into())
                }
            );
            assert_eq!(
                read(&directory.0.join(".workbench/selections.json"))
                    .unwrap()
                    .as_deref(),
                Some("external work")
            );
        }
    }

    #[test]
    fn native_delete_checks_loaded_contents_and_confirms_absence() {
        let directory = Directory::new();
        directory.seed("drafts/draft_one.json", "old work");
        assert!(matches!(
            mutate(
                &directory.0,
                "drafts/draft_one.json",
                None,
                None,
                "project_one"
            )
            .unwrap(),
            Mutation::Conflict {
                phase: "before-write",
                ..
            }
        ));
        assert_eq!(
            mutate(
                &directory.0,
                "drafts/draft_one.json",
                Some("old work"),
                None,
                "project_one"
            )
            .unwrap(),
            Mutation::Written
        );
        assert!(!directory
            .0
            .join(".workbench/drafts/draft_one.json")
            .exists());
    }

    #[test]
    fn native_scratch_records_live_in_their_own_directory() {
        let directory = Directory::new();
        assert_eq!(
            mutate(
                &directory.0,
                "scratch/scratch_branch.json",
                None,
                Some("local scratch"),
                "project_one"
            )
            .unwrap(),
            Mutation::Written
        );
        assert_eq!(
            read(&directory.0.join(".workbench/scratch/scratch_branch.json"))
                .unwrap()
                .as_deref(),
            Some("local scratch")
        );
        assert!(list(&directory.0).unwrap().iter().any(|file| matches!(
            file,
            File::Read { path, contents } if path == "scratch/scratch_branch.json" && contents == "local scratch"
        )));
        assert_eq!(
            mutate(
                &directory.0,
                "scratch/scratch_branch.json",
                Some("local scratch"),
                None,
                "project_one"
            )
            .unwrap(),
            Mutation::Written
        );
        assert!(!directory
            .0
            .join(".workbench/scratch/scratch_branch.json")
            .exists());
        for path in [
            "scratch/scratch_.json",
            "scratch/draft_one.json",
            "scratch/scratch_a/b.json",
            "drafts/scratch_one.json",
        ] {
            assert!(
                mutate(&directory.0, path, None, Some("personal"), "project_one").is_err(),
                "accepted {path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn native_scratch_directory_cannot_be_a_symlink() {
        use std::os::unix::fs::symlink;
        let directory = Directory::new();
        let outside = Directory::new();
        fs::create_dir_all(directory.0.join(".workbench")).unwrap();
        symlink(&outside.0, directory.0.join(".workbench/scratch")).unwrap();
        assert!(mutate(
            &directory.0,
            "scratch/scratch_branch.json",
            None,
            Some("personal"),
            "project_one"
        )
        .is_err());
        assert!(fs::read_dir(&outside.0).unwrap().next().is_none());
    }

    #[test]
    fn native_recovery_rejects_unsafe_paths_before_creating_anything() {
        let directory = Directory::new();
        for path in [
            "../project.json",
            "drafts/../../escape.json",
            "drafts\\draft_one.json",
            ".gitignore",
            "drafts/draft_.json",
        ] {
            assert!(mutate(&directory.0, path, None, Some("personal"), "project_one").is_err());
        }
        assert!(!directory.0.join(".workbench").exists());
    }

    #[cfg(unix)]
    #[test]
    fn native_recovery_refuses_symlinks_at_every_recovery_boundary() {
        use std::os::unix::fs::symlink;
        for path in [
            ".workbench",
            ".workbench/drafts",
            ".workbench/.gitignore",
            ".workbench/selections.json",
        ] {
            let directory = Directory::new();
            let outside = Directory::new();
            let target = directory.0.join(path);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            symlink(&outside.0, &target).unwrap();
            let result = mutate(
                &directory.0,
                "selections.json",
                None,
                Some("personal"),
                "project_one",
            );
            // A linked ignore file is a protection refusal; other links are errors.
            assert!(
                if path == ".workbench/.gitignore" {
                    matches!(
                        result,
                        Ok(Mutation::Blocked {
                            reason: "protection",
                            ..
                        })
                    )
                } else {
                    result.is_err()
                },
                "accepted {path}"
            );
            assert!(fs::read_dir(&outside.0).unwrap().next().is_none());
        }
    }
}

#[derive(Clone, Deserialize, Serialize)]
pub struct MigrationPayload {
    pub path: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum MigrationStage {
    Staged,
    Blocked {
        reason: &'static str,
        message: String,
    },
    Conflict {
        path: String,
        phase: &'static str,
        actual_bytes: Option<Vec<u8>>,
    },
    Failed {
        path: String,
        message: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ByteFile {
    Read { path: String, bytes: Vec<u8> },
    Unavailable { path: String, error: String },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MigrationSnapshot {
    pub manifest: Option<Vec<u8>>,
    pub files: Vec<ByteFile>,
}

fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    reject_link(path)?;
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read {}: {error}", path.display())),
    }
}

fn migration_files(directory: &Path) -> Result<Vec<ByteFile>, String> {
    fn collect(
        parent: &Path,
        prefix: &str,
        depth: usize,
        files: &mut Vec<ByteFile>,
    ) -> Result<(), String> {
        reject_link(parent)?;
        let entries = match fs::read_dir(parent) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("Could not inspect migration inventory: {error}")),
        };
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = format!("{prefix}/{name}");
            // Symlinks are neither directories nor files here: retained as unexpected entries.
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_dir() && depth < 2 && (depth == 0 || name == "candidates") {
                collect(&entry.path(), &path, depth + 1, files)?;
            } else if file_type.is_file() {
                files.push(match read_bytes(&entry.path()) {
                    Ok(Some(bytes)) => ByteFile::Read { path, bytes },
                    Ok(None) => ByteFile::Unavailable {
                        path,
                        error: "Migration file disappeared.".into(),
                    },
                    Err(error) => ByteFile::Unavailable { path, error },
                });
            } else {
                files.push(ByteFile::Unavailable {
                    path,
                    error: "Unexpected migration entry.".into(),
                });
            }
        }
        Ok(())
    }
    reject_link(&directory.join(".workbench"))?;
    let mut files = Vec::new();
    collect(
        &directory.join(".workbench/migrations"),
        "migrations",
        0,
        &mut files,
    )?;
    files.sort_by(|left, right| {
        let (ByteFile::Read { path: a, .. } | ByteFile::Unavailable { path: a, .. }) = left;
        let (ByteFile::Read { path: b, .. } | ByteFile::Unavailable { path: b, .. }) = right;
        a.cmp(b)
    });
    Ok(files)
}

/// Active records stay raw bytes, so BOMs and invalid UTF-8 survive exact
/// comparison and reach core's strict validation.
pub fn read_migration(directory: &Path) -> Result<MigrationSnapshot, String> {
    let mut files = migration_files(directory)?;
    files.extend(active_records(directory)?);
    Ok(MigrationSnapshot {
        manifest: read_bytes(&directory.join("project.json"))?,
        files,
    })
}

/// The fixed migration layout, as core's `assertMigrationPath`.
fn valid_migration_path(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    fn hash(value: &str) -> bool {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }
    parts.len() >= 3
        && parts[0] == "migrations"
        && parts[1].strip_prefix("migration_").is_some_and(hash)
        && match parts.as_slice() {
            [_, _, "source.project.json" | "journal.json" | "shared.project.json"] => true,
            [_, _, "candidates", "selections.json"] => true,
            [_, _, "candidates", name] => name
                .strip_prefix("draft_migrated-")
                .and_then(|id| id.strip_suffix(".json"))
                .is_some_and(hash),
            _ => false,
        }
}

fn migration_destination(directory: &Path, path: &str) -> Result<PathBuf, String> {
    if !valid_migration_path(path) {
        return Err("Invalid migration path.".into());
    }
    let mut target = directory.join(".workbench");
    reject_link(&target)?;
    for part in path.split('/') {
        target.push(part);
        reject_link(&target)?;
    }
    Ok(target)
}

pub fn stage_migration(
    directory: &Path,
    project_id: &str,
    files: &[MigrationPayload],
) -> Result<MigrationStage, String> {
    stage_migration_with(directory, project_id, files, |_| Ok(()))
}

fn stage_migration_with(
    directory: &Path,
    project_id: &str,
    files: &[MigrationPayload],
    mut after_write: impl FnMut(&Path) -> Result<(), String>,
) -> Result<MigrationStage, String> {
    if files.len() < 4 {
        return Err("Migration batch is incomplete.".into());
    }
    let root = files[0]
        .path
        .rsplit_once('/')
        .ok_or("Invalid migration root.")?
        .0;
    let mut unique = std::collections::HashSet::new();
    for file in files {
        migration_destination(directory, &file.path)?;
        if !file.path.starts_with(&format!("{root}/")) || !unique.insert(&file.path) {
            return Err("Invalid migration batch identity.".into());
        }
    }
    for (index, suffix) in [
        "source.project.json",
        "journal.json",
        "shared.project.json",
        "candidates/selections.json",
    ]
    .iter()
    .enumerate()
    {
        if files[index].path != format!("{root}/{suffix}") {
            return Err("Invalid migration staging order.".into());
        }
    }
    let proposed: Vec<File> = files
        .iter()
        .filter_map(|file| {
            String::from_utf8(file.bytes.clone())
                .ok()
                .map(|contents| File::Read {
                    path: file.path.clone(),
                    contents,
                })
        })
        .collect();
    if foreign(&proposed, project_id) {
        return Ok(MigrationStage::Blocked {
            reason: "foreign-project",
            message: "Migration payload belongs to a different project.".into(),
        });
    }
    for file in files {
        let mut attempt = || -> Result<MigrationStage, String> {
            let inventory = list(directory)?;
            if inventory.iter().any(|entry| matches!(entry, File::Unavailable { path, .. } if path.starts_with("migrations"))) { return Err("Migration inventory is unavailable.".into()); }
            if foreign(&inventory, project_id) {
                return Ok(MigrationStage::Blocked {
                    reason: "foreign-project",
                    message: "Workbench belongs to a different project.".into(),
                });
            }
            if read_bytes(&directory.join("project.json"))?.as_deref()
                != Some(files[0].bytes.as_slice())
            {
                return Ok(MigrationStage::Blocked {
                    reason: "manifest-diverged",
                    message: "Manifest no longer matches migration source.".into(),
                });
            }
            let workbench = directory.join(".workbench");
            reject_link(&workbench)?;
            fs::create_dir_all(&workbench).map_err(|error| error.to_string())?;
            if let Err(message) = protect(&workbench) {
                return Ok(MigrationStage::Blocked {
                    reason: "protection",
                    message,
                });
            }
            let target = migration_destination(directory, &file.path)?;
            if let Some(actual) = read_bytes(&target)? {
                return Ok(if actual == file.bytes {
                    MigrationStage::Staged
                } else {
                    MigrationStage::Conflict {
                        path: file.path.clone(),
                        phase: "before-write",
                        actual_bytes: Some(actual),
                    }
                });
            }
            fs::create_dir_all(target.parent().ok_or("Migration file has no parent.")?)
                .map_err(|error| error.to_string())?;
            // Immutable staging never replaces an existing file. A partial write is retained for review.
            use std::io::Write;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|error| error.to_string())?;
            output
                .write_all(&file.bytes)
                .map_err(|error| error.to_string())?;
            after_write(&target)?;
            let actual = read_bytes(&target)?;
            Ok(if actual.as_deref() == Some(file.bytes.as_slice()) {
                MigrationStage::Staged
            } else {
                MigrationStage::Conflict {
                    path: file.path.clone(),
                    phase: "read-back",
                    actual_bytes: actual,
                }
            })
        };
        match attempt() {
            Ok(MigrationStage::Staged) => (),
            Ok(outcome) => return Ok(outcome),
            Err(message) => {
                return Ok(MigrationStage::Failed {
                    path: file.path.clone(),
                    message,
                })
            }
        }
    }
    Ok(MigrationStage::Staged)
}

#[cfg(test)]
mod migration_tests {
    use super::*;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("inference-lens-migration-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            fs::write(path.join("project.json"), b"\xef\xbb\xbf{}\r\n").unwrap();
            Self(path)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn payloads() -> Vec<MigrationPayload> {
        let root = format!("migrations/migration_{}/", "a".repeat(64));
        [
            ("source.project.json", b"\xef\xbb\xbf{}\r\n".to_vec()),
            ("journal.json", b"{\"projectId\":\"project_one\"}".to_vec()),
            (
                "shared.project.json",
                b"{\"projectId\":\"project_one\"}".to_vec(),
            ),
            (
                "candidates/selections.json",
                b"{\"projectId\":\"project_one\"}".to_vec(),
            ),
        ]
        .into_iter()
        .map(|(path, bytes)| MigrationPayload {
            path: root.clone() + path,
            bytes,
        })
        .collect()
    }
    #[test]
    fn staging_preserves_raw_source_bytes_before_any_candidates() {
        let directory = Directory::new();
        let files = payloads();
        stage_migration(&directory.0, "project_one", &files).unwrap();
        assert_eq!(
            fs::read(directory.0.join(".workbench").join(&files[0].path)).ok(),
            Some(files[0].bytes.clone())
        );
    }
    #[test]
    fn a_foreign_staged_candidate_blocks_ordinary_records() {
        let directory = Directory::new();
        let files = payloads();
        let foreign = directory.0.join(".workbench").join(&files[3].path);
        fs::create_dir_all(foreign.parent().unwrap()).unwrap();
        fs::write(foreign, b"{\"projectId\":\"project_foreign\"}").unwrap();
        assert!(matches!(
            mutate(
                &directory.0,
                "selections.json",
                None,
                Some("personal"),
                "project_one"
            )
            .unwrap(),
            Mutation::Blocked {
                reason: "foreign-project",
                ..
            }
        ));
    }
    #[test]
    fn migration_read_is_read_only_and_roundtrips_binary_bytes() {
        let directory = Directory::new();
        let snapshot = read_migration(&directory.0).unwrap();
        assert_eq!(snapshot.manifest, Some(b"\xef\xbb\xbf{}\r\n".to_vec()));
        assert!(snapshot.files.is_empty());
        assert!(!directory.0.join(".workbench").exists());
        let files = payloads();
        assert_eq!(
            stage_migration(&directory.0, "project_one", &files).unwrap(),
            MigrationStage::Staged
        );
        assert_eq!(
            fs::read(directory.0.join("project.json")).unwrap(),
            files[0].bytes
        );
        assert_eq!(
            fs::read(directory.0.join(".workbench/.gitignore")).unwrap(),
            b"*\n"
        );
        assert_eq!(
            read_migration(&directory.0).unwrap().files.len(),
            files.len()
        );
        assert_eq!(
            stage_migration(&directory.0, "project_one", &files).unwrap(),
            MigrationStage::Staged
        );
    }
    #[test]
    fn every_native_interruption_preserves_prior_files_and_explicit_retry_finishes() {
        for boundary in 0..payloads().len() {
            let directory = Directory::new();
            let files = payloads();
            let mut written = 0;
            let result = stage_migration_with(&directory.0, "project_one", &files, |_| {
                let stop = written == boundary;
                written += 1;
                if stop {
                    Err("injected interruption".into())
                } else {
                    Ok(())
                }
            })
            .unwrap();
            assert!(matches!(result, MigrationStage::Failed { .. }));
            for file in &files[..=boundary] {
                assert_eq!(
                    fs::read(directory.0.join(".workbench").join(&file.path)).unwrap(),
                    file.bytes
                );
            }
            for file in &files[boundary + 1..] {
                assert!(!directory.0.join(".workbench").join(&file.path).exists());
            }
            assert_eq!(
                fs::read(directory.0.join("project.json")).unwrap(),
                files[0].bytes
            );
            assert_eq!(
                stage_migration(&directory.0, "project_one", &files).unwrap(),
                MigrationStage::Staged
            );
        }
    }
    #[test]
    fn every_native_readback_mismatch_preserves_interference_and_stops() {
        for boundary in 0..payloads().len() {
            let directory = Directory::new();
            let files = payloads();
            let mut written = 0;
            let result = stage_migration_with(&directory.0, "project_one", &files, |path| {
                if written == boundary {
                    fs::write(path, b"external bytes").unwrap();
                }
                written += 1;
                Ok(())
            })
            .unwrap();
            assert_eq!(
                result,
                MigrationStage::Conflict {
                    path: files[boundary].path.clone(),
                    phase: "read-back",
                    actual_bytes: Some(b"external bytes".to_vec())
                }
            );
            assert_eq!(
                fs::read(directory.0.join(".workbench").join(&files[boundary].path)).unwrap(),
                b"external bytes"
            );
            assert!(!matches!(
                stage_migration(&directory.0, "project_one", &files).unwrap(),
                MigrationStage::Staged
            ));
        }
    }
    #[test]
    fn migration_preserves_existing_active_records_and_refuses_stale_snapshots() {
        let directory = Directory::new();
        let files = payloads();
        let active = directory.0.join(".workbench/selections.json");
        fs::create_dir_all(active.parent().unwrap()).unwrap();
        fs::write(&active, b"existing personal selections").unwrap();
        assert_eq!(
            stage_migration(&directory.0, "project_one", &files).unwrap(),
            MigrationStage::Staged
        );
        assert_eq!(fs::read(active).unwrap(), b"existing personal selections");
        let target = directory.0.join(".workbench").join(&files[2].path);
        fs::write(&target, b"changed snapshot").unwrap();
        assert_eq!(
            stage_migration(&directory.0, "project_one", &files).unwrap(),
            MigrationStage::Conflict {
                path: files[2].path.clone(),
                phase: "before-write",
                actual_bytes: Some(b"changed snapshot".to_vec())
            }
        );
        assert_eq!(fs::read(target).unwrap(), b"changed snapshot");
    }
    #[test]
    fn migration_refuses_protection_changes_and_manifest_changes() {
        for problem in ["protection", "manifest", "foreign"] {
            let directory = Directory::new();
            let files = payloads();
            let result = stage_migration_with(&directory.0, "project_one", &files, |_| {
                match problem {
                    "protection" => {
                        fs::write(directory.0.join(".workbench/.gitignore"), b"custom").unwrap()
                    }
                    "manifest" => fs::write(directory.0.join("project.json"), b"changed").unwrap(),
                    _ => fs::write(
                        directory.0.join(".workbench/selections.json"),
                        b"{\"projectId\":\"project_foreign\"}",
                    )
                    .unwrap(),
                }
                Ok(())
            })
            .unwrap();
            assert!(matches!(result, MigrationStage::Blocked { .. }));
            assert!(!directory.0.join(".workbench").join(&files[1].path).exists());
        }
    }
    #[test]
    fn migration_rejects_unsafe_paths_before_creating_protection() {
        for unsafe_path in [
            "../project.json",
            "migrations/migration_bad/source.project.json",
            "migrations/migration_aaaaaaaa/../../project.json",
        ] {
            let directory = Directory::new();
            let mut files = payloads();
            files[0].path = unsafe_path.into();
            assert!(stage_migration(&directory.0, "project_one", &files).is_err());
            assert!(!directory.0.join(".workbench").exists());
        }
    }
    #[cfg(unix)]
    #[test]
    fn migration_rejects_symlinks_at_every_new_path_boundary() {
        use std::os::unix::fs::symlink;
        let files = payloads();
        let root = files[0].path.rsplit_once('/').unwrap().0;
        for suffix in [
            ".workbench".to_owned(),
            ".workbench/migrations".to_owned(),
            format!(".workbench/{root}"),
            format!(".workbench/{root}/candidates"),
            format!(".workbench/{}", files[0].path),
            format!(".workbench/{}", files[1].path),
            format!(".workbench/{}", files[2].path),
            format!(".workbench/{}", files[3].path),
        ] {
            let directory = Directory::new();
            let outside = Directory::new();
            let link = directory.0.join(&suffix);
            fs::create_dir_all(link.parent().unwrap()).unwrap();
            symlink(&outside.0, &link).unwrap();
            assert!(
                !matches!(
                    stage_migration(&directory.0, "project_one", &files),
                    Ok(MigrationStage::Staged)
                ),
                "accepted {suffix}"
            );
            assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
        }
    }
    #[test]
    fn a_partially_written_migration_file_does_not_block_ordinary_records() {
        let directory = Directory::new();
        let files = payloads();
        let partial = directory.0.join(".workbench").join(&files[1].path);
        fs::create_dir_all(partial.parent().unwrap()).unwrap();
        // A write interrupted inside a multi-byte character.
        fs::write(&partial, b"{\"note\":\"\xe2\x82").unwrap();
        assert_eq!(
            mutate(
                &directory.0,
                "selections.json",
                None,
                Some("personal"),
                "project_one"
            ),
            Ok(Mutation::Written)
        );
        let snapshot = read_migration(&directory.0).unwrap();
        assert!(snapshot.files.iter().any(|file| matches!(
            file,
            ByteFile::Read { path, bytes } if *path == files[1].path && bytes == b"{\"note\":\"\xe2\x82"
        )));
    }
    #[test]
    fn migration_snapshots_read_active_records_as_raw_bytes() {
        let directory = Directory::new();
        let workbench = directory.0.join(".workbench");
        fs::create_dir_all(workbench.join("drafts")).unwrap();
        // A BOM must stay distinct from the staged bytes, and invalid UTF-8
        // must reach strict validation rather than becoming an error string.
        let bom = b"\xef\xbb\xbf{\"projectId\":\"project_one\"}".to_vec();
        let invalid = b"{\"projectId\":\"project_one\",\"x\":\"\xff\"}".to_vec();
        fs::write(workbench.join("drafts/draft_bom.json"), &bom).unwrap();
        fs::write(workbench.join("selections.json"), &invalid).unwrap();
        let snapshot = read_migration(&directory.0).unwrap();
        for (path, bytes) in [
            ("drafts/draft_bom.json", &bom),
            ("selections.json", &invalid),
        ] {
            assert!(
                snapshot.files.iter().any(|file| matches!(
                    file,
                    ByteFile::Read { path: actual, bytes: actual_bytes } if actual == path && actual_bytes == bytes
                )),
                "{path} was not read as raw bytes"
            );
        }
        // Ordinary workbench reads keep their text contract.
        assert!(list(&directory.0).unwrap().iter().any(
            |file| matches!(file, File::Unavailable { path, .. } if path == "selections.json")
        ));
    }
    #[cfg(unix)]
    #[test]
    fn a_nested_migration_symlink_is_inventory_for_review_not_a_listing_failure() {
        use std::os::unix::fs::symlink;
        let directory = Directory::new();
        let outside = Directory::new();
        let files = payloads();
        let link = directory.0.join(".workbench").join(&files[1].path);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        symlink(outside.0.join("project.json"), &link).unwrap();
        assert!(list(&directory.0)
            .unwrap()
            .iter()
            .any(|file| matches!(file, File::Unavailable { path, .. } if *path == files[1].path)));
        assert!(read_migration(&directory.0).unwrap().files.iter().any(
            |file| matches!(file, ByteFile::Unavailable { path, .. } if *path == files[1].path)
        ));
        assert!(mutate(
            &directory.0,
            "selections.json",
            None,
            Some("personal"),
            "project_one"
        )
        .is_err());
        assert!(!directory.0.join(".workbench/selections.json").exists());
    }
}
