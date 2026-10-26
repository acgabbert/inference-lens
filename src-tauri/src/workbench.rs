use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::Serialize;

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
    Blocked {
        message: String,
    },
}

fn destination(directory: &Path, path: &str) -> Result<PathBuf, String> {
    let safe = path == "selections.json"
        || path
            .strip_prefix("drafts/draft_")
            .and_then(|suffix| suffix.strip_suffix(".json"))
            .is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
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

pub fn list(directory: &Path) -> Result<Vec<File>, String> {
    let workbench = directory.join(".workbench");
    reject_link(&workbench)?;
    let mut files = Vec::new();
    for (parent, prefix) in [(&workbench, ""), (&workbench.join("drafts"), "drafts/")] {
        reject_link(parent)?;
        let entries = match fs::read_dir(parent) {
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
            files.push(match read(&entry.path()) {
                Ok(Some(contents)) => File::Read { path, contents },
                Ok(None) => File::Unavailable {
                    path,
                    error: "Recovery record disappeared while reading.".into(),
                },
                Err(error) => File::Unavailable { path, error },
            });
        }
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
        serde_json::from_str::<serde_json::Value>(contents)
            .ok()
            .and_then(|value| value.get("projectId")?.as_str().map(str::to_owned))
            .is_some_and(|id| id != project_id)
    })
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
    if foreign(&list(directory)?, project_id) {
        return Ok(Mutation::Blocked {
            message: "Workbench belongs to a different project. Preserve it before reconciling."
                .into(),
        });
    }
    reject_link(&workbench)?;
    fs::create_dir_all(&workbench)
        .map_err(|error| format!("Could not create recovery directory: {error}"))?;
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
    reject_link(&workbench.join("drafts"))?;
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
        directory.seed(".gitignore", "# custom\n");
        assert!(mutate(
            &directory.0,
            "selections.json",
            None,
            Some("personal"),
            "project_one"
        )
        .is_err());
        assert!(!directory.0.join(".workbench/selections.json").exists());
        assert_eq!(
            read(&directory.0.join(".workbench/.gitignore"))
                .unwrap()
                .as_deref(),
            Some("# custom\n")
        );
        fs::remove_file(directory.0.join(".workbench/.gitignore")).unwrap();
        fs::create_dir(directory.0.join(".workbench/.gitignore")).unwrap();
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
            assert!(
                mutate(
                    &directory.0,
                    "selections.json",
                    None,
                    Some("personal"),
                    "project_one"
                )
                .is_err(),
                "accepted {path}"
            );
            assert!(fs::read_dir(&outside.0).unwrap().next().is_none());
        }
    }
}
