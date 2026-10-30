//! Native host for completing a staged shared-project migration. Core prepares
//! and verifies the plan; this host only rechecks it against disk under the
//! workspace mutex and performs the writes it names. It never regenerates
//! migration outputs, deletes anything or rolls back.

use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{
    destination as record_destination, read_bytes, read_migration, reject_link,
    valid_migration_path, ByteFile, File, MigrationSnapshot, IGNORE,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    pub candidate: String,
    pub destination: String,
    pub bytes: Vec<u8>,
}

/// Core's checked plan, carried over IPC as byte arrays.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub project_id: String,
    pub operation_id: String,
    pub expected: MigrationSnapshot,
    pub source: Vec<u8>,
    pub shared: Vec<u8>,
    pub activations: Vec<Activation>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Stop {
    pub destination: String,
    pub phase: &'static str,
    pub message: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum Completion {
    /// Nothing was attempted; the caller must request a new preview.
    StalePlan,
    Blocked {
        reason: &'static str,
        message: String,
    },
    Executed {
        manifest: &'static str,
        activated: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stopped: Option<Stop>,
    },
}

const MANIFEST: &str = "project.json";
const PROTECTION_MESSAGE: &str =
    "Workbench .gitignore must contain exactly '*\\n' before personal content can be written.";

/// `attempted` becomes true once the manifest write is attempted or the
/// shared snapshot is found already present; the caller invalidates the
/// workspace's ordinary saves from then on.
///
/// The hook runs before each phase of each path ("before-write", "write",
/// "read-back"); the command passes a no-op. An error fails that phase; side
/// effects simulate interference in tests. Everything before the first
/// content write only reads, so an error there returns `Err` with nothing
/// attempted.
pub fn complete(
    directory: &Path,
    project_id: &str,
    plan: &Plan,
    attempted: &mut bool,
    mut hook: impl FnMut(&str, &'static str) -> Result<(), String>,
) -> Result<Completion, String> {
    validate(plan, project_id)?;
    let current = read_migration(directory)?;
    if !same_snapshot(&current, &plan.expected) {
        return Ok(Completion::StalePlan);
    }
    if foreign(&current.files, project_id) {
        return Err(FOREIGN_MESSAGE.into());
    }
    if !is_protected(directory) {
        return Ok(Completion::Blocked {
            reason: "protection",
            message: PROTECTION_MESSAGE.into(),
        });
    }
    let manifest_path = directory.join(MANIFEST);
    let mut manifest = "already-shared";
    if current.manifest.as_deref() == Some(plan.source.as_slice()) {
        hook(MANIFEST, "before-write")?;
        // The expected-source check immediately before replacement; nothing has been written yet.
        if read_bytes(&manifest_path)?.as_deref() != Some(plan.source.as_slice()) {
            return Ok(Completion::StalePlan);
        }
        *attempted = true;
        if let Some(stopped) = replace_manifest(directory, &plan.shared, &mut hook) {
            return Ok(Completion::Executed {
                manifest: "failed",
                activated: Vec::new(),
                stopped: Some(stopped),
            });
        }
        manifest = "written";
    } else {
        *attempted = true;
    }
    let mut activated: Vec<&Activation> = Vec::new();
    for activation in &plan.activations {
        if let Some(stopped) = activate(
            directory, project_id, plan, activation, &activated, &mut hook,
        ) {
            return Ok(Completion::Executed {
                manifest,
                activated: activated
                    .iter()
                    .map(|item| item.destination.clone())
                    .collect(),
                stopped: Some(stopped),
            });
        }
        activated.push(activation);
    }
    Ok(Completion::Executed {
        manifest,
        activated: activated
            .into_iter()
            .map(|item| item.destination.clone())
            .collect(),
        stopped: None,
    })
}

const FOREIGN_MESSAGE: &str =
    "Workbench belongs to a different project. Preserve it before reconciling.";

/// Binds every write to the staged operation, so a plan can never become an
/// arbitrary path writer. It does not regenerate core's migration outputs.
fn validate(plan: &Plan, project_id: &str) -> Result<(), String> {
    let invalid = |reason: String| format!("Invalid completion plan: {reason}.");
    if plan.project_id != project_id {
        return Err(invalid("it belongs to another project".into()));
    }
    let root = format!("migrations/{}/", plan.operation_id);
    if !valid_migration_path(&format!("{root}source.project.json")) {
        return Err(invalid("the operation is not a migration".into()));
    }
    let staged = |path: &str| {
        plan.expected
            .files
            .iter()
            .find_map(|file| match file {
                ByteFile::Read {
                    path: actual,
                    bytes,
                } if *actual == format!("{root}{path}") => Some(bytes.as_slice()),
                _ => None,
            })
            .ok_or_else(|| invalid(format!("{path} is not staged in this operation")))
    };
    if plan.source != staged("source.project.json")? {
        return Err(invalid("the source is not the staged source".into()));
    }
    if plan.shared != staged("shared.project.json")? {
        return Err(invalid(
            "the shared manifest is not the staged snapshot".into(),
        ));
    }
    let manifest = plan.expected.manifest.as_deref();
    if manifest != Some(plan.source.as_slice()) && manifest != Some(plan.shared.as_slice()) {
        return Err(invalid("the manifest matches neither snapshot".into()));
    }
    let mut destinations = std::collections::HashSet::new();
    for activation in &plan.activations {
        let name = activation
            .candidate
            .strip_prefix("candidates/")
            .filter(|_| valid_migration_path(&format!("{root}{}", activation.candidate)))
            .ok_or_else(|| invalid(format!("{} is not a candidate", activation.candidate)))?;
        let expected = if name == "selections.json" {
            name.to_owned()
        } else {
            format!("drafts/{name}")
        };
        if activation.destination != expected {
            return Err(invalid(format!(
                "{} does not activate at {}",
                activation.candidate, activation.destination
            )));
        }
        if activation.bytes != staged(&activation.candidate)? {
            return Err(invalid(format!(
                "{} is not the staged bytes",
                activation.candidate
            )));
        }
        let occupied = plan
            .expected
            .files
            .iter()
            .any(|file| file_path(file) == expected);
        if occupied || !destinations.insert(expected.clone()) {
            return Err(invalid(format!("{expected} is not absent")));
        }
    }
    Ok(())
}

fn file_path(file: &ByteFile) -> &str {
    let (ByteFile::Read { path, .. } | ByteFile::Unavailable { path, .. }) = file;
    path
}

/// Exact inventory equality by path; an unreadable entry matches only another unreadable entry.
fn same_snapshot(left: &MigrationSnapshot, right: &MigrationSnapshot) -> bool {
    if left.manifest != right.manifest || left.files.len() != right.files.len() {
        return false;
    }
    let right: std::collections::HashMap<&str, &ByteFile> = right
        .files
        .iter()
        .map(|file| (file_path(file), file))
        .collect();
    right.len() == left.files.len()
        && left
            .files
            .iter()
            .all(|file| match (file, right.get(file_path(file))) {
                (ByteFile::Read { bytes, .. }, Some(ByteFile::Read { bytes: other, .. })) => {
                    bytes == other
                }
                (ByteFile::Unavailable { .. }, Some(ByteFile::Unavailable { .. })) => true,
                _ => false,
            })
}

fn foreign(files: &[ByteFile], project_id: &str) -> bool {
    let text: Vec<File> = files
        .iter()
        .filter_map(|file| match file {
            ByteFile::Read { path, bytes } => Some(File::Read {
                path: path.clone(),
                contents: String::from_utf8_lossy(bytes).into_owned(),
            }),
            ByteFile::Unavailable { .. } => None,
        })
        .collect();
    super::foreign(&text, project_id)
}

/// Completion never creates or repairs protection; successful staging already
/// established it. A linked or unreadable policy is not protection.
fn is_protected(directory: &Path) -> bool {
    let workbench = directory.join(".workbench");
    reject_link(&workbench).is_ok()
        && read_bytes(&workbench.join(".gitignore"))
            .is_ok_and(|bytes| bytes.as_deref() == Some(IGNORE.as_bytes()))
}

fn replace_manifest(
    directory: &Path,
    shared: &[u8],
    hook: &mut impl FnMut(&str, &'static str) -> Result<(), String>,
) -> Option<Stop> {
    let path = directory.join(MANIFEST);
    let stop = |phase, message| {
        Some(Stop {
            destination: MANIFEST.into(),
            phase,
            message,
        })
    };
    if let Err(message) = hook(MANIFEST, "write")
        .and_then(|()| reject_link(&path))
        .and_then(|()| crate::write_project_file(directory, &path, shared))
    {
        return stop("write", message);
    }
    match hook(MANIFEST, "read-back").and_then(|()| read_bytes(&path)) {
        Ok(Some(bytes)) if bytes == shared => None,
        Ok(_) => stop(
            "read-back",
            "Manifest read-back does not match the shared snapshot.".into(),
        ),
        Err(message) => stop("read-back", message),
    }
}

/// Creates one absent record after rechecking everything the shared write and
/// earlier activations established. Exclusive creation never replaces a file.
fn activate(
    directory: &Path,
    project_id: &str,
    plan: &Plan,
    activation: &Activation,
    activated: &[&Activation],
    hook: &mut impl FnMut(&str, &'static str) -> Result<(), String>,
) -> Option<Stop> {
    let destination = activation.destination.as_str();
    let stop = |phase, message: String| {
        Some(Stop {
            destination: destination.into(),
            phase,
            message,
        })
    };
    let checked = (|| -> Result<Result<PathBuf, String>, String> {
        hook(destination, "before-write")?;
        let mut expected = plan.expected.clone();
        expected.manifest = Some(plan.shared.clone());
        expected
            .files
            .extend(activated.iter().map(|item| ByteFile::Read {
                path: item.destination.clone(),
                bytes: item.bytes.clone(),
            }));
        let current = read_migration(directory)?;
        if !same_snapshot(&current, &expected) || foreign(&current.files, project_id) {
            return Ok(Err(
                "The project or its recovery files changed during completion.".into(),
            ));
        }
        if !is_protected(directory) {
            return Ok(Err(PROTECTION_MESSAGE.into()));
        }
        let target = record_destination(directory, destination)?;
        let parent = target.parent().ok_or("Recovery record has no parent.")?;
        reject_link(parent)?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create draft directory: {error}"))?;
        reject_link(parent)?;
        if read_bytes(&target)?.is_some() {
            return Ok(Err("The destination appeared during completion.".into()));
        }
        Ok(Ok(target))
    })();
    let target = match checked {
        Ok(Ok(target)) => target,
        Ok(Err(message)) | Err(message) => return stop("before-write", message),
    };
    let written = hook(destination, "write").and_then(|()| {
        use std::io::Write;
        // A failed write can leave a partial file; it is reported, never removed.
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .and_then(|mut file| file.write_all(&activation.bytes))
            .map_err(|error| format!("Could not write recovery record: {error}"))
    });
    if let Err(message) = written {
        return stop("write", message);
    }
    match hook(destination, "read-back").and_then(|()| read_bytes(&target)) {
        Ok(Some(bytes)) if bytes == activation.bytes => None,
        Ok(_) => stop(
            "read-back",
            "Read-back does not match the staged candidate.".into(),
        ),
        Err(message) => stop("read-back", message),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::{read_migration, stage_migration, MigrationPayload, MigrationStage};
    use super::*;

    pub(crate) const SOURCE: &[u8] = b"\xef\xbb\xbf{\"schemaVersion\":15}\r\n";
    pub(crate) const SHARED: &[u8] =
        b"{\n  \"schemaVersion\": 19,\n  \"projectId\": \"project_one\"\n}\n";
    const SELECTIONS: &[u8] = b"{\"kind\":\"selections\",\"projectId\":\"project_one\"}\n";
    const DRAFT: &[u8] = b"{\"kind\":\"draft\",\"projectId\":\"project_one\"}\n";

    fn root() -> String {
        format!("migrations/migration_{}", "a".repeat(64))
    }
    fn draft_name() -> String {
        format!("draft_migrated-{}.json", "b".repeat(64))
    }
    fn draft_destination() -> String {
        format!("drafts/{}", draft_name())
    }

    pub(crate) struct Staged(pub(crate) PathBuf);
    impl Staged {
        /// A project whose migration is staged by the native staging command.
        pub(crate) fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "inference-lens-completion-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir(&path).unwrap();
            fs::write(path.join("project.json"), SOURCE).unwrap();
            let root = root();
            let files: Vec<MigrationPayload> = [
                ("source.project.json".to_owned(), SOURCE),
                (
                    "journal.json".to_owned(),
                    b"{\"projectId\":\"project_one\"}\n".as_slice(),
                ),
                ("shared.project.json".to_owned(), SHARED),
                ("candidates/selections.json".to_owned(), SELECTIONS),
                (format!("candidates/{}", draft_name()), DRAFT),
            ]
            .into_iter()
            .map(|(path, bytes)| MigrationPayload {
                path: format!("{root}/{path}"),
                bytes: bytes.to_vec(),
            })
            .collect();
            assert_eq!(
                stage_migration(&path, "project_one", &files).unwrap(),
                MigrationStage::Staged
            );
            Self(path)
        }
        pub(crate) fn path(&self, relative: &str) -> PathBuf {
            self.0.join(relative)
        }
        pub(crate) fn read(&self, relative: &str) -> Option<Vec<u8>> {
            fs::read(self.path(relative)).ok()
        }
        pub(crate) fn write(&self, relative: &str, bytes: &[u8]) {
            let path = self.path(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        /// Every file under the project, for whole-tree before/after comparison.
        fn tree(&self) -> Vec<(String, Vec<u8>)> {
            fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
                for entry in fs::read_dir(dir).unwrap() {
                    let path = entry.unwrap().path();
                    let meta = fs::symlink_metadata(&path).unwrap();
                    let name = path.strip_prefix(base).unwrap().display().to_string();
                    if meta.is_dir() {
                        walk(base, &path, out);
                    } else if meta.is_file() {
                        out.push((name, fs::read(&path).unwrap()));
                    } else {
                        out.push((name, b"<link>".to_vec()));
                    }
                }
            }
            let mut out = Vec::new();
            walk(&self.0, &self.0, &mut out);
            out.sort();
            out
        }
        /// The plan core would prepare from a fresh snapshot: every absent candidate activates.
        pub(crate) fn plan(&self) -> Plan {
            let expected = read_migration(&self.0).unwrap();
            let mut activations = Vec::new();
            for (candidate, destination, bytes) in [
                (
                    "candidates/selections.json".to_owned(),
                    "selections.json".to_owned(),
                    SELECTIONS,
                ),
                (
                    format!("candidates/{}", draft_name()),
                    draft_destination(),
                    DRAFT,
                ),
            ] {
                if !self.path(&format!(".workbench/{destination}")).exists() {
                    activations.push(Activation {
                        candidate,
                        destination,
                        bytes: bytes.to_vec(),
                    });
                }
            }
            Plan {
                project_id: "project_one".into(),
                operation_id: format!("migration_{}", "a".repeat(64)),
                expected,
                source: SOURCE.to_vec(),
                shared: SHARED.to_vec(),
                activations,
            }
        }
        fn staged_untouched(&self) {
            let root = root();
            for (path, bytes) in [
                ("source.project.json".to_owned(), SOURCE),
                ("shared.project.json".to_owned(), SHARED),
                ("candidates/selections.json".to_owned(), SELECTIONS),
                (format!("candidates/{}", draft_name()), DRAFT),
            ] {
                assert_eq!(
                    self.read(&format!(".workbench/{root}/{path}")).as_deref(),
                    Some(bytes),
                    "{path} must be preserved"
                );
            }
            assert_eq!(
                self.read(".workbench/.gitignore").as_deref(),
                Some(b"*\n".as_slice())
            );
        }
    }
    impl Drop for Staged {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn run(staged: &Staged, plan: &Plan) -> (Result<Completion, String>, bool) {
        let mut attempted = false;
        let result = complete(
            &staged.0,
            "project_one",
            plan,
            &mut attempted,
            |_, _| Ok(()),
        );
        (result, attempted)
    }

    fn run_with(
        staged: &Staged,
        plan: &Plan,
        hook: impl FnMut(&str, &'static str) -> Result<(), String>,
    ) -> (Result<Completion, String>, bool) {
        let mut attempted = false;
        let result = complete(&staged.0, "project_one", plan, &mut attempted, hook);
        (result, attempted)
    }

    fn executed(manifest: &'static str, activated: &[&str], stopped: Option<Stop>) -> Completion {
        Completion::Executed {
            manifest,
            activated: activated.iter().map(|item| (*item).to_owned()).collect(),
            stopped,
        }
    }

    #[test]
    fn writes_the_exact_shared_manifest_then_each_absent_candidate_in_order() {
        let staged = Staged::new();
        let plan = staged.plan();
        let mut writes = Vec::new();
        let (result, attempted) = run_with(&staged, &plan, |path, phase| {
            if phase == "write" {
                writes.push(path.to_owned());
            }
            Ok(())
        });
        let draft = draft_destination();
        assert_eq!(
            result.unwrap(),
            executed("written", &["selections.json", &draft], None)
        );
        assert!(attempted);
        assert_eq!(staged.read("project.json").as_deref(), Some(SHARED));
        assert_eq!(
            staged.read(".workbench/selections.json").as_deref(),
            Some(SELECTIONS)
        );
        assert_eq!(
            staged.read(&format!(".workbench/{draft}")).as_deref(),
            Some(DRAFT)
        );
        assert_eq!(writes, ["project.json", "selections.json", draft.as_str()]);
        staged.staged_untouched();
        // No temporary file is left beside the manifest.
        assert_eq!(
            fs::read_dir(&staged.0)
                .unwrap()
                .filter(|entry| entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .ends_with(".tmp"))
                .count(),
            0
        );
    }

    #[test]
    fn a_repeated_completion_recognizes_shared_output_and_writes_nothing() {
        let staged = Staged::new();
        run(&staged, &staged.plan()).0.unwrap();
        let before = staged.tree();
        let plan = staged.plan();
        assert!(plan.activations.is_empty());
        let (result, attempted) = run(&staged, &plan);
        assert_eq!(result.unwrap(), executed("already-shared", &[], None));
        assert!(
            attempted,
            "recognizing shared output invalidates ordinary saves"
        );
        assert_eq!(staged.tree(), before);
    }

    #[test]
    fn restart_after_shared_write_activates_only_absent_records_without_rewriting() {
        let staged = Staged::new();
        staged.write("project.json", SHARED);
        staged.write(".workbench/selections.json", SELECTIONS);
        let plan = staged.plan();
        assert_eq!(plan.activations.len(), 1);
        let mut writes = Vec::new();
        let (result, _) = run_with(&staged, &plan, |path, phase| {
            if phase == "write" {
                writes.push(path.to_owned());
            }
            Ok(())
        });
        let draft = draft_destination();
        assert_eq!(result.unwrap(), executed("already-shared", &[&draft], None));
        assert_eq!(writes, [draft.as_str()]);
        assert_eq!(staged.read("project.json").as_deref(), Some(SHARED));
    }

    #[test]
    fn existing_selections_and_competing_drafts_are_never_overwritten() {
        let staged = Staged::new();
        // Core leaves occupied destinations out of the plan; the host still refuses them.
        staged.write(
            ".workbench/selections.json",
            b"{\"projectId\":\"project_one\",\"mine\":1}",
        );
        let mut plan = staged.plan();
        plan.activations.insert(
            0,
            Activation {
                candidate: "candidates/selections.json".into(),
                destination: "selections.json".into(),
                bytes: SELECTIONS.to_vec(),
            },
        );
        let before = staged.tree();
        let (result, attempted) = run(&staged, &plan);
        assert!(result.is_err(), "{result:?}");
        assert!(!attempted);
        assert_eq!(staged.tree(), before);
    }

    #[test]
    fn a_changed_snapshot_is_a_stale_plan_with_nothing_written_or_invalidated() {
        for change in ["manifest", "active", "staged", "new-record"] {
            let staged = Staged::new();
            let plan = staged.plan();
            match change {
                "manifest" => staged.write("project.json", b"{\"schemaVersion\":15,\"edited\":1}"),
                "active" => staged.write(".workbench/drafts/draft_other.json", b"{}"),
                "staged" => staged.write(
                    &format!(".workbench/{}/shared.project.json", root()),
                    b"tampered",
                ),
                _ => staged.write(".workbench/selections.json", SELECTIONS),
            }
            let before = staged.tree();
            let (result, attempted) = run(&staged, &plan);
            assert_eq!(result, Ok(Completion::StalePlan), "{change}");
            assert!(!attempted, "{change}");
            assert_eq!(staged.tree(), before, "{change}");
        }
    }

    #[test]
    fn a_manifest_change_just_before_replacement_is_a_stale_plan() {
        let staged = Staged::new();
        let plan = staged.plan();
        let (result, attempted) = run_with(&staged, &plan, |path, phase| {
            if (path, phase) == ("project.json", "before-write") {
                fs::write(staged.path("project.json"), b"external").unwrap();
            }
            Ok(())
        });
        assert_eq!(result, Ok(Completion::StalePlan));
        assert!(!attempted);
        assert_eq!(
            staged.read("project.json").as_deref(),
            Some(b"external".as_slice())
        );
        assert!(!staged.path(".workbench/selections.json").exists());
    }

    #[test]
    fn missing_or_custom_protection_blocks_without_repair() {
        for protection in [None, Some(b"# custom\n".as_slice())] {
            let staged = Staged::new();
            match protection {
                None => fs::remove_file(staged.path(".workbench/.gitignore")).unwrap(),
                Some(bytes) => staged.write(".workbench/.gitignore", bytes),
            }
            let plan = staged.plan();
            let before = staged.tree();
            let (result, attempted) = run(&staged, &plan);
            assert!(
                matches!(
                    result,
                    Ok(Completion::Blocked {
                        reason: "protection",
                        ..
                    })
                ),
                "{result:?}"
            );
            assert!(!attempted);
            assert_eq!(staged.tree(), before, "protection is read, never created");
        }
    }

    #[test]
    fn a_foreign_identity_blocks_before_any_write() {
        let staged = Staged::new();
        staged.write(
            ".workbench/drafts/draft_foreign.json",
            b"{\"projectId\":\"project_foreign\"}",
        );
        let plan = staged.plan();
        let before = staged.tree();
        let (result, attempted) = run(&staged, &plan);
        assert!(result.is_err(), "{result:?}");
        assert!(!attempted);
        assert_eq!(staged.tree(), before);
    }

    #[test]
    fn a_failed_or_mismatched_manifest_write_stops_before_activation_and_keeps_source() {
        for phase in ["write", "read-back"] {
            let staged = Staged::new();
            let plan = staged.plan();
            let (result, attempted) = run_with(&staged, &plan, |path, at| {
                if (path, at) != ("project.json", phase) {
                    return Ok(());
                }
                if phase == "write" {
                    return Err("injected write failure".into());
                }
                fs::write(staged.path("project.json"), b"interference").unwrap();
                Ok(())
            });
            let Ok(Completion::Executed {
                manifest,
                activated,
                stopped: Some(stop),
            }) = result
            else {
                panic!("{phase}: {result:?}");
            };
            assert_eq!(
                (
                    manifest,
                    activated.len(),
                    stop.destination.as_str(),
                    stop.phase
                ),
                ("failed", 0, "project.json", phase)
            );
            assert!(
                attempted,
                "{phase}: an uncertain attempt still invalidates saves"
            );
            let expected: &[u8] = if phase == "write" {
                SOURCE
            } else {
                b"interference"
            };
            assert_eq!(
                staged.read("project.json").as_deref(),
                Some(expected),
                "no rollback"
            );
            assert!(!staged.path(".workbench/selections.json").exists());
            staged.staged_untouched();
        }
    }

    #[test]
    fn every_activation_boundary_stops_and_keeps_earlier_progress() {
        let draft = draft_destination();
        for (index, destination) in ["selections.json", draft.as_str()].iter().enumerate() {
            for phase in ["before-write", "write", "read-back"] {
                let staged = Staged::new();
                let plan = staged.plan();
                let (result, attempted) = run_with(&staged, &plan, |path, at| {
                    if (path, at) != (*destination, phase) {
                        return Ok(());
                    }
                    match phase {
                        // Interference between the snapshot and this activation.
                        "before-write" => {
                            staged.write(".workbench/drafts/draft_other.json", b"{}");
                            Ok(())
                        }
                        "write" => Err("injected write failure".into()),
                        _ => {
                            staged.write(&format!(".workbench/{destination}"), b"interference");
                            Ok(())
                        }
                    }
                });
                let label = format!("{destination} {phase}");
                let Ok(Completion::Executed {
                    manifest,
                    activated,
                    stopped: Some(stop),
                }) = result
                else {
                    panic!("{label}: {result:?}");
                };
                assert_eq!(manifest, "written", "{label}");
                assert_eq!(activated, ["selections.json"][..index], "{label}");
                assert_eq!(
                    (stop.destination.as_str(), stop.phase),
                    (*destination, phase)
                );
                assert!(attempted);
                assert_eq!(
                    staged.read("project.json").as_deref(),
                    Some(SHARED),
                    "{label}"
                );
                if index == 1 {
                    assert_eq!(
                        staged.read(".workbench/selections.json").as_deref(),
                        Some(SELECTIONS),
                        "{label}: earlier activation kept"
                    );
                }
                let actual = staged.read(&format!(".workbench/{destination}"));
                match phase {
                    "read-back" => assert_eq!(actual.as_deref(), Some(b"interference".as_slice())),
                    _ => assert_eq!(actual, None, "{label}"),
                }
                if index == 0 {
                    assert!(
                        !staged.path(&format!(".workbench/{draft}")).exists(),
                        "{label}"
                    );
                }
                staged.staged_untouched();
            }
        }
    }

    #[test]
    fn plans_not_bound_to_the_staged_operation_are_refused_before_any_write() {
        let draft = draft_destination();
        type Change = Box<dyn Fn(&mut Plan)>;
        let cases: Vec<(&str, Change)> = vec![
            (
                "project",
                Box::new(|plan| plan.project_id = "project_other".into()),
            ),
            (
                "operation",
                Box::new(|plan| plan.operation_id = format!("migration_{}", "c".repeat(64))),
            ),
            ("source", Box::new(|plan| plan.source = b"{}".to_vec())),
            ("shared", Box::new(|plan| plan.shared = b"{}".to_vec())),
            (
                "manifest",
                Box::new(|plan| plan.expected.manifest = Some(b"{}".to_vec())),
            ),
            (
                "candidate",
                Box::new(|plan| plan.activations[0].candidate = "journal.json".into()),
            ),
            (
                "escape",
                Box::new(|plan| {
                    plan.activations[0].candidate = "candidates/../../../project.json".into()
                }),
            ),
            (
                "destination",
                Box::new(|plan| plan.activations[0].destination = "drafts/draft_x.json".into()),
            ),
            (
                "swapped",
                Box::new(move |plan| plan.activations[1].destination = "selections.json".into()),
            ),
            (
                "bytes",
                Box::new(|plan| plan.activations[1].bytes = b"{}".to_vec()),
            ),
            (
                "duplicate",
                Box::new(|plan| {
                    let first = plan.activations[0].clone();
                    plan.activations.push(first);
                }),
            ),
            (
                "traversal",
                Box::new(move |plan| {
                    plan.activations[1].destination = format!("drafts/../{draft}")
                }),
            ),
        ];
        for (label, change) in cases {
            let staged = Staged::new();
            let mut plan = staged.plan();
            change(&mut plan);
            let before = staged.tree();
            let (result, attempted) = run(&staged, &plan);
            assert!(result.is_err(), "{label}: {result:?}");
            assert!(!attempted, "{label}");
            assert_eq!(staged.tree(), before, "{label}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_refused_at_every_path_level() {
        use std::os::unix::fs::symlink;
        let draft = draft_destination();
        for link in [
            "project.json".to_owned(),
            ".workbench".to_owned(),
            ".workbench/drafts".to_owned(),
            ".workbench/.gitignore".to_owned(),
            ".workbench/selections.json".to_owned(),
            format!(".workbench/{draft}"),
        ] {
            // Linked after the plan was prepared, and again between activations.
            for between_activations in [false, true] {
                let staged = Staged::new();
                let outside = tempdir();
                let plan = staged.plan();
                let make_link = || {
                    let target = staged.path(&link);
                    fs::create_dir_all(target.parent().unwrap()).unwrap();
                    // Set the real entry aside outside both trees being compared.
                    if target.is_dir() {
                        fs::rename(&target, staged.path(".set-aside")).unwrap();
                    } else if target.exists() {
                        fs::remove_file(&target).unwrap();
                    }
                    symlink(&outside, &target).unwrap();
                };
                if !between_activations {
                    make_link();
                }
                let outside_before = listing(&outside);
                let mut linked = false;
                let (result, _) = run_with(&staged, &plan, |path, phase| {
                    if between_activations && !linked && path == draft && phase == "before-write" {
                        linked = true;
                        make_link();
                    }
                    Ok(())
                });
                let label = format!("{link} (between activations: {between_activations})");
                assert!(
                    !matches!(result, Ok(Completion::Executed { stopped: None, .. })),
                    "{label}: {result:?}"
                );
                assert_eq!(
                    listing(&outside),
                    outside_before,
                    "{label}: nothing written through the link"
                );
                let _ = fs::remove_dir_all(&outside);
            }
        }
    }

    fn tempdir() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("inference-lens-outside-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        path
    }

    fn listing(path: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out: Vec<_> = walkdir(path);
        out.sort();
        out
    }

    fn walkdir(path: &Path) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        for entry in fs::read_dir(path).unwrap() {
            let entry = entry.unwrap().path();
            if entry.is_dir() {
                out.extend(walkdir(&entry));
            } else {
                out.push((
                    entry.display().to_string(),
                    fs::read(&entry).unwrap_or_default(),
                ));
            }
        }
        out
    }

    #[test]
    fn plans_and_results_round_trip_raw_bytes_over_json_ipc() {
        let plan: Plan = serde_json::from_value(serde_json::json!({
            "projectId": "project_one",
            "operationId": "migration_x",
            "expected": {
                "manifest": [0, 239, 187, 191, 255],
                "files": [
                    { "path": "selections.json", "bytes": [255, 0] },
                    { "path": "drafts/draft_x.json", "error": "unreadable" }
                ]
            },
            "source": [0, 255],
            "shared": [],
            "activations": [{ "candidate": "candidates/selections.json", "destination": "selections.json", "bytes": [13, 10] }]
        }))
        .unwrap();
        assert_eq!(plan.expected.manifest, Some(vec![0, 239, 187, 191, 255]));
        assert!(
            matches!(&plan.expected.files[0], ByteFile::Read { bytes, .. } if bytes == &[255, 0])
        );
        assert!(
            matches!(&plan.expected.files[1], ByteFile::Unavailable { error, .. } if error == "unreadable")
        );
        assert_eq!(plan.activations[0].bytes, [13, 10]);
        assert!(serde_json::from_value::<Plan>(serde_json::json!({
            "projectId": "p", "operationId": "o", "expected": { "manifest": [256], "files": [] },
            "source": [], "shared": [], "activations": []
        }))
        .is_err(), "bytes outside 0..=255 are rejected, not wrapped");
        assert_eq!(
            serde_json::to_value(Completion::StalePlan).unwrap(),
            serde_json::json!({ "kind": "stale-plan" })
        );
        assert_eq!(
            serde_json::to_value(executed("written", &["selections.json"], None)).unwrap(),
            serde_json::json!({ "kind": "executed", "manifest": "written", "activated": ["selections.json"] })
        );
        assert_eq!(
            serde_json::to_value(executed(
                "already-shared",
                &[],
                Some(Stop {
                    destination: "selections.json".into(),
                    phase: "read-back",
                    message: "m".into()
                })
            ))
            .unwrap(),
            serde_json::json!({
                "kind": "executed", "manifest": "already-shared", "activated": [],
                "stopped": { "destination": "selections.json", "phase": "read-back", "message": "m" }
            })
        );
    }

    #[test]
    fn git_tracks_only_the_shared_manifest_after_native_completion() {
        use std::process::Command;
        let staged = Staged::new();
        assert!(
            !staged.path(".gitignore").exists(),
            "no bundle ignore rules"
        );
        run(&staged, &staged.plan()).0.unwrap();
        let git = |args: &[&str]| {
            let output = Command::new("git")
                .args(args)
                .current_dir(&staged.0)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", staged.path(".git-test-config"))
                .output()
                .expect("git is required for this test");
            assert!(output.status.success(), "git {args:?}: {output:?}");
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        };
        git(&["init", "--quiet"]);
        git(&["add", "--all"]);
        assert_eq!(git(&["diff", "--cached", "--name-only"]), "project.json");
        assert_eq!(staged.read("project.json").as_deref(), Some(SHARED));
        for destination in ["selections.json".to_owned(), draft_destination()] {
            let path = format!(".workbench/{destination}");
            assert!(staged.path(&path).exists());
            assert_eq!(git(&["check-ignore", &path]), path);
        }
    }
}
