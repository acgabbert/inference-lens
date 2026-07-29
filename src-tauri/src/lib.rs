use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use futures_util::StreamExt;
#[cfg(not(debug_assertions))]
use keyring::Entry;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;
use url::Url;

#[cfg(not(debug_assertions))]
const KEYCHAIN_SERVICE: &str = "app.inferencelens.desktop";

#[derive(Clone, Default)]
struct ActiveRuns(Arc<Mutex<HashMap<String, CancellationToken>>>);

const PROJECT_DIRECTORY_SUFFIX: &str = ".inference-lens";
const PROJECT_FILE_NAME: &str = "project.json";
const PROJECT_GITIGNORE_CONTENTS: &str = "*\n";
const TRACES_DIRECTORY_NAME: &str = "traces";

#[derive(Default)]
struct ProjectWorkspaces(Mutex<HashMap<String, ProjectWorkspaceState>>);

struct ProjectWorkspaceState {
    directory: PathBuf,
    last_contents: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeProjectWorkspace {
    workspace_id: String,
    display_name: String,
    display_path: String,
    contents: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeRunTraceFile {
    file_name: String,
    contents: String,
}

#[cfg(not(debug_assertions))]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredCredential {
    version: u8,
    api_key: String,
    approved_origin: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
enum CredentialSelection {
    None,
    Provided { api_key: String },
    NativeKeychain { profile_id: String },
}

struct ResolvedCredential {
    api_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialStatus {
    can_persist: bool,
    is_stored: bool,
    is_approved_for_endpoint: bool,
}

#[derive(Serialize)]
struct ProviderTurnAccepted {
    status: u16,
}

/// The raw-proxy channel payload emitted on
/// `inference-lens://provider-turn/{requestId}`. Rust forwards bytes; parsing and
/// normalization into provider-neutral events happens in TypeScript.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RawStreamEvent {
    Response {
        status: u16,
        headers: Value,
    },
    /// Complete SSE lines from one network chunk, CR/LF stripped.
    Lines {
        lines: Vec<String>,
    },
    /// One complete non-streaming JSON response body.
    Body {
        body: String,
    },
    End,
    Error {
        kind: &'static str,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
    },
    Cancelled,
}

fn command_error(message: impl Into<String>) -> String {
    message.into()
}

fn project_manifest_path(directory: &Path) -> PathBuf {
    directory.join(PROJECT_FILE_NAME)
}

fn validate_project_bundle_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
        || !name.ends_with(PROJECT_DIRECTORY_SUFFIX)
    {
        return Err(command_error("The project bundle name is invalid."));
    }
    Ok(())
}

fn create_project_bundle(
    parent: &Path,
    bundle_name: &str,
    contents: &str,
    protect_from_git: bool,
) -> Result<PathBuf, String> {
    validate_project_bundle_name(bundle_name)?;
    let directory = parent.join(bundle_name);
    if directory.exists() {
        return Err(command_error(format!(
            "{bundle_name} already exists in the selected folder. Open it instead or choose another name."
        )));
    }
    fs::create_dir(&directory)
        .map_err(|error| format!("Could not create the project bundle: {error}"))?;
    if protect_from_git {
        if let Err(error) = fs::write(directory.join(".gitignore"), PROJECT_GITIGNORE_CONTENTS) {
            let _ = fs::remove_dir(&directory);
            return Err(format!("Could not protect the project from Git: {error}"));
        }
    }
    if let Err(error) = write_project_manifest(&directory, contents) {
        if protect_from_git {
            let _ = fs::remove_file(directory.join(".gitignore"));
        }
        let _ = fs::remove_dir(&directory);
        return Err(error);
    }
    Ok(directory)
}

fn selected_project_directory(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|path| {
            path.into_path()
                .map_err(|error| format!("Could not use the selected folder: {error}"))
                .and_then(|path| {
                    path.canonicalize()
                        .map_err(|error| format!("Could not open the selected folder: {error}"))
                })
        })
        .transpose()
}

fn write_project_manifest(directory: &Path, contents: &str) -> Result<(), String> {
    let manifest = project_manifest_path(directory);
    let temporary = directory.join(format!(
        ".inference-lens-project-{}.tmp",
        uuid::Uuid::new_v4()
    ));
    fs::write(&temporary, contents)
        .map_err(|error| format!("Could not write the project: {error}"))?;
    if let Err(rename_error) = fs::rename(&temporary, &manifest) {
        // std::fs::rename cannot replace an existing file on every supported
        // platform. The fallback still writes a complete temporary file first.
        fs::copy(&temporary, &manifest).map_err(|copy_error| {
            let _ = fs::remove_file(&temporary);
            format!(
                "Could not replace the project file ({rename_error}); fallback failed: {copy_error}"
            )
        })?;
        fs::remove_file(&temporary)
            .map_err(|error| format!("Could not clean up the project save: {error}"))?;
    }
    Ok(())
}

fn trace_file_name(run_id: &str) -> Result<String, String> {
    if !run_id.starts_with("run_")
        || run_id.len() <= "run_".len()
        || run_id.contains("..")
        || !run_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err(command_error("Run ID cannot be used as a trace filename."));
    }
    Ok(format!("{run_id}.json"))
}

fn write_run_trace(directory: &Path, run_id: &str, contents: &str) -> Result<(), String> {
    let traces = directory.join(TRACES_DIRECTORY_NAME);
    fs::create_dir_all(&traces)
        .map_err(|error| format!("Could not create the traces directory: {error}"))?;
    let file_name = trace_file_name(run_id)?;
    let destination = traces.join(&file_name);
    if destination.exists() {
        let existing = fs::read_to_string(&destination)
            .map_err(|error| format!("Could not read the existing run trace: {error}"))?;
        if existing == contents {
            return Ok(());
        }
        return Err(command_error(format!(
            "{file_name} already exists with different contents. Run traces are immutable."
        )));
    }
    let temporary = traces.join(format!(".inference-lens-run-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&temporary, contents)
        .map_err(|error| format!("Could not write the run trace: {error}"))?;
    fs::rename(&temporary, &destination).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Could not finalize the run trace: {error}")
    })
}

/// Mirrors `isTraceEntryName` in `packages/core/src/run-trace.ts`. A history
/// entry is discovered rather than derived from a validated run ID, so the name
/// is re-checked before it is joined onto the traces directory again.
fn is_trace_entry_name(file_name: &str) -> bool {
    file_name.ends_with(".json")
        && file_name.len() > ".json".len()
        && !file_name.contains("..")
        && !file_name.starts_with(['.', '-', '_'])
        && file_name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
}

fn read_run_traces(directory: &Path) -> Result<Vec<NativeRunTraceFile>, String> {
    let traces = directory.join(TRACES_DIRECTORY_NAME);
    let entries = match fs::read_dir(&traces) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Could not read the traces directory: {error}")),
    };
    let mut files = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let file_name = entry.file_name().into_string().ok()?;
            if !is_trace_entry_name(&file_name) {
                return None;
            }
            Some((file_name, entry.path()))
        })
        .map(|(file_name, path)| {
            fs::read_to_string(&path)
                .map(|contents| NativeRunTraceFile {
                    file_name,
                    contents,
                })
                .map_err(|error| format!("Could not read {}: {error}", path.display()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    files.sort_by(|left, right| left.file_name.cmp(&right.file_name));
    Ok(files)
}

fn read_single_run_trace(directory: &Path, file_name: &str) -> Result<String, String> {
    if !is_trace_entry_name(file_name) {
        return Err(command_error(format!(
            "{file_name} is not a run trace file name."
        )));
    }
    let path = directory.join(TRACES_DIRECTORY_NAME).join(file_name);
    fs::read_to_string(&path).map_err(|error| format!("Could not read {file_name}: {error}"))
}

fn write_exported_trace(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| command_error("The selected trace location has no parent directory."))?;
    let temporary = parent.join(format!(
        ".inference-lens-export-{}.tmp",
        uuid::Uuid::new_v4()
    ));
    fs::write(&temporary, contents)
        .map_err(|error| format!("Could not save the run trace: {error}"))?;
    if let Err(rename_error) = fs::rename(&temporary, path) {
        fs::copy(&temporary, path).map_err(|copy_error| {
            let _ = fs::remove_file(&temporary);
            format!(
                "Could not replace the selected trace file ({rename_error}); fallback failed: {copy_error}"
            )
        })?;
        fs::remove_file(&temporary)
            .map_err(|error| format!("Could not clean up the trace export: {error}"))?;
    }
    Ok(())
}

fn register_project_workspace(
    workspaces: &ProjectWorkspaces,
    directory: PathBuf,
    contents: String,
) -> NativeProjectWorkspace {
    let workspace_id = format!("workspace_{}", uuid::Uuid::new_v4());
    let display_name = directory
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Inference Lens project")
        .to_owned();
    let display_path = directory.to_string_lossy().into_owned();
    workspaces
        .0
        .lock()
        .expect("project workspaces lock poisoned")
        .insert(
            workspace_id.clone(),
            ProjectWorkspaceState {
                directory,
                last_contents: contents.clone(),
            },
        );
    NativeProjectWorkspace {
        workspace_id,
        display_name,
        display_path,
        contents,
    }
}

#[tauri::command]
async fn open_project_workspace(
    app: AppHandle,
    workspaces: State<'_, ProjectWorkspaces>,
) -> Result<Option<NativeProjectWorkspace>, String> {
    let Some(directory) = selected_project_directory(&app)? else {
        return Ok(None);
    };
    let manifest = project_manifest_path(&directory);
    let contents = fs::read_to_string(&manifest).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("The selected folder does not contain {PROJECT_FILE_NAME}.")
        } else {
            format!("Could not read the project: {error}")
        }
    })?;
    Ok(Some(register_project_workspace(
        &workspaces,
        directory,
        contents,
    )))
}

#[tauri::command]
async fn create_project_workspace(
    app: AppHandle,
    workspaces: State<'_, ProjectWorkspaces>,
    contents: String,
    bundle_name: String,
    protect_from_git: bool,
) -> Result<Option<NativeProjectWorkspace>, String> {
    let Some(parent) = selected_project_directory(&app)? else {
        return Ok(None);
    };
    let directory = create_project_bundle(&parent, &bundle_name, &contents, protect_from_git)?;
    Ok(Some(register_project_workspace(
        &workspaces,
        directory,
        contents,
    )))
}

#[tauri::command]
fn save_project_workspace(
    workspaces: State<'_, ProjectWorkspaces>,
    workspace_id: String,
    contents: String,
) -> Result<(), String> {
    let mut workspaces = workspaces
        .0
        .lock()
        .map_err(|_| command_error("Project workspace state is unavailable."))?;
    let workspace = workspaces
        .get_mut(&workspace_id)
        .ok_or_else(|| command_error("This project folder is no longer open."))?;
    let manifest = project_manifest_path(&workspace.directory);
    let current_contents = fs::read_to_string(&manifest)
        .map_err(|error| format!("Could not read the project: {error}"))?;
    if current_contents != workspace.last_contents {
        return Err(command_error(format!(
            "{PROJECT_FILE_NAME} changed outside Inference Lens. Reopen the project before saving."
        )));
    }
    write_project_manifest(&workspace.directory, &contents)?;
    workspace.last_contents = contents;
    Ok(())
}

#[tauri::command]
fn save_run_trace(
    workspaces: State<'_, ProjectWorkspaces>,
    workspace_id: String,
    run_id: String,
    contents: String,
) -> Result<(), String> {
    let workspaces = workspaces
        .0
        .lock()
        .map_err(|_| command_error("Project workspace state is unavailable."))?;
    let workspace = workspaces
        .get(&workspace_id)
        .ok_or_else(|| command_error("This project folder is no longer open."))?;
    write_run_trace(&workspace.directory, &run_id, &contents)
}

#[tauri::command]
fn list_run_traces(
    workspaces: State<'_, ProjectWorkspaces>,
    workspace_id: String,
) -> Result<Vec<NativeRunTraceFile>, String> {
    let workspaces = workspaces
        .0
        .lock()
        .map_err(|_| command_error("Project workspace state is unavailable."))?;
    let workspace = workspaces
        .get(&workspace_id)
        .ok_or_else(|| command_error("This project folder is no longer open."))?;
    read_run_traces(&workspace.directory)
}

#[tauri::command]
fn read_run_trace(
    workspaces: State<'_, ProjectWorkspaces>,
    workspace_id: String,
    file_name: String,
) -> Result<String, String> {
    let workspaces = workspaces
        .0
        .lock()
        .map_err(|_| command_error("Project workspace state is unavailable."))?;
    let workspace = workspaces
        .get(&workspace_id)
        .ok_or_else(|| command_error("This project folder is no longer open."))?;
    read_single_run_trace(&workspace.directory, &file_name)
}

#[tauri::command]
async fn export_run_trace(
    app: AppHandle,
    run_id: String,
    contents: String,
) -> Result<Option<String>, String> {
    let file_name = trace_file_name(&run_id)?;
    let Some(selected) = app
        .dialog()
        .file()
        .add_filter("Inference Lens run trace", &["json"])
        .set_file_name(file_name)
        .set_title("Save run trace")
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|error| format!("Could not use the selected trace location: {error}"))?;
    write_exported_trace(&path, &contents)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn validate_profile_id(profile_id: &str) -> Result<(), String> {
    if profile_id.trim().is_empty() {
        return Err(command_error("A profile ID is required."));
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn entry(profile_id: &str) -> Result<Entry, String> {
    validate_profile_id(profile_id)?;
    Entry::new(KEYCHAIN_SERVICE, profile_id).map_err(|error| error.to_string())
}

fn endpoint_origin(endpoint: &str) -> Result<String, String> {
    let parsed = Url::parse(endpoint.trim())
        .map_err(|_| command_error("Endpoint must be a valid HTTP or HTTPS URL."))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(command_error("Endpoint must use HTTP or HTTPS."));
    }
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" {
        return Err(command_error("Endpoint must include a host."));
    }
    Ok(origin)
}

#[cfg(not(debug_assertions))]
fn credential_for(profile_id: &str, endpoint: &str) -> Result<StoredCredential, String> {
    let stored = entry(profile_id)?
        .get_password()
        .map_err(|_| command_error("No secure credential is stored for this profile."))?;
    let credential: StoredCredential = serde_json::from_str(&stored)
        .map_err(|_| command_error("The stored credential is invalid. Enter it again."))?;
    if credential.version != 1 || credential.api_key.trim().is_empty() {
        return Err(command_error(
            "The stored credential is invalid. Enter it again.",
        ));
    }
    if credential.approved_origin != endpoint_origin(endpoint)? {
        return Err(command_error(
            "This credential is not approved for the current endpoint origin. Enter it again to bind it.",
        ));
    }
    Ok(credential)
}

fn resolve_credential(
    selection: CredentialSelection,
    endpoint: &str,
) -> Result<ResolvedCredential, String> {
    match selection {
        CredentialSelection::None => {
            endpoint_origin(endpoint)?;
            Ok(ResolvedCredential { api_key: None })
        }
        CredentialSelection::Provided { api_key } => {
            #[cfg(not(debug_assertions))]
            {
                let _ = api_key;
                Err(command_error(
                    "Production builds require a credential stored in the OS keychain.",
                ))
            }

            #[cfg(debug_assertions)]
            {
                let api_key = api_key.trim();
                if api_key.is_empty() {
                    return Err(command_error("Enter an API key for this session."));
                }
                endpoint_origin(endpoint)?;
                Ok(ResolvedCredential {
                    api_key: Some(api_key.to_owned()),
                })
            }
        }
        CredentialSelection::NativeKeychain { profile_id } => {
            #[cfg(debug_assertions)]
            {
                let _ = profile_id;
                Err(command_error(
                    "Development builds use session-only credentials.",
                ))
            }

            #[cfg(not(debug_assertions))]
            {
                credential_for(&profile_id, endpoint).map(|credential| ResolvedCredential {
                    api_key: Some(credential.api_key),
                })
            }
        }
    }
}

#[cfg(not(debug_assertions))]
#[tauri::command]
fn store_credential(profile_id: String, endpoint: String, api_key: String) -> Result<(), String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return entry(&profile_id)?
            .delete_credential()
            .or_else(|error| {
                // Keychain reports a missing item as an error; deleting an absent
                // secret is still the desired end state.
                if error.to_string().to_lowercase().contains("not found") {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(|error| error.to_string());
    }
    let credential = StoredCredential {
        version: 1,
        api_key: api_key.to_owned(),
        approved_origin: endpoint_origin(&endpoint)?,
    };
    let serialized = serde_json::to_string(&credential).map_err(|error| error.to_string())?;
    entry(&profile_id)?
        .set_password(&serialized)
        .map_err(|error| error.to_string())
}

#[cfg(debug_assertions)]
#[tauri::command]
fn store_credential(profile_id: String, endpoint: String, api_key: String) -> Result<(), String> {
    validate_profile_id(&profile_id)?;
    endpoint_origin(&endpoint)?;
    let _ = api_key;
    Err(command_error(
        "Development builds keep credentials in memory for the current session.",
    ))
}

#[cfg(not(debug_assertions))]
#[tauri::command]
fn credential_status(profile_id: String, endpoint: String) -> Result<CredentialStatus, String> {
    let origin = endpoint_origin(&endpoint)?;
    let Ok(password) = entry(&profile_id)?.get_password() else {
        return Ok(CredentialStatus {
            can_persist: true,
            is_stored: false,
            is_approved_for_endpoint: false,
        });
    };
    let Ok(credential) = serde_json::from_str::<StoredCredential>(&password) else {
        return Ok(CredentialStatus {
            can_persist: true,
            is_stored: true,
            is_approved_for_endpoint: false,
        });
    };
    Ok(CredentialStatus {
        can_persist: true,
        is_stored: !credential.api_key.trim().is_empty(),
        is_approved_for_endpoint: credential.approved_origin == origin,
    })
}

#[cfg(debug_assertions)]
#[tauri::command]
fn credential_status(profile_id: String, endpoint: String) -> Result<CredentialStatus, String> {
    validate_profile_id(&profile_id)?;
    endpoint_origin(&endpoint)?;
    Ok(CredentialStatus {
        can_persist: false,
        is_stored: false,
        is_approved_for_endpoint: false,
    })
}

/// Bytes are capped by character count, consistent with the 4,000-character
/// error-detail cap used elsewhere in this file.
const MODELS_RESPONSE_BODY_CAP: usize = 256_000;

#[derive(Serialize)]
struct ModelDiscoveryProxyResponse {
    status: u16,
    body: String,
}

/// Streaming HTTP proxy for `GET /models`: attaches the resolved credential
/// and returns the raw response body. TypeScript already enforces the
/// `modelDiscovery` capability check and parses/normalizes the body — Rust
/// never inspects provider protocol shape.
#[tauri::command]
async fn discover_models(
    endpoint: String,
    credential: CredentialSelection,
) -> Result<ModelDiscoveryProxyResponse, String> {
    let credential = resolve_credential(credential, &endpoint)?;
    let models_url = models_url(&endpoint)?;
    let request = Client::new().get(models_url);
    let request = match credential.api_key {
        Some(api_key) => request.bearer_auth(api_key),
        None => request,
    };
    let response = request
        .send()
        .await
        .map_err(|error| format!("Could not reach provider: {error}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read provider response: {error}"))?;
    Ok(ModelDiscoveryProxyResponse {
        status,
        body: body.chars().take(MODELS_RESPONSE_BODY_CAP).collect(),
    })
}

#[tauri::command]
fn cancel_provider_turn(request_id: String, active_runs: State<'_, ActiveRuns>) {
    if let Some(token) = active_runs
        .0
        .lock()
        .expect("active runs lock poisoned")
        .get(&request_id)
    {
        token.cancel();
    }
}

/// Streaming HTTP proxy: attaches the resolved credential and forwards raw
/// SSE lines. The webview builds the request body and normalizes the
/// response; Rust never parses provider protocol semantics.
///
/// `endpoint`, not a caller-supplied URL, is what the credential was resolved
/// against — the request URL is derived from it here so a compromised
/// webview cannot redirect the API key to an arbitrary host.
#[tauri::command]
async fn start_provider_turn(
    app: AppHandle,
    active_runs: State<'_, ActiveRuns>,
    request_id: String,
    credential: CredentialSelection,
    endpoint: String,
    body: String,
    streaming: bool,
) -> Result<ProviderTurnAccepted, String> {
    if !request_id.starts_with("provider-turn_") {
        return Err(command_error("Provider turn identifiers are invalid."));
    }
    let credential = resolve_credential(credential, &endpoint)?;
    let cancellation = CancellationToken::new();
    active_runs
        .0
        .lock()
        .expect("active runs lock poisoned")
        .insert(request_id.clone(), cancellation.clone());
    let state = active_runs.inner().clone();
    tauri::async_runtime::spawn(async move {
        execute_provider_turn(
            app,
            state,
            request_id,
            OutboundProviderRequest {
                endpoint,
                body,
                streaming,
            },
            credential,
            cancellation,
        )
        .await;
    });
    Ok(ProviderTurnAccepted { status: 202 })
}

impl ActiveRuns {
    fn remove(&self, request_id: &str) {
        self.0
            .lock()
            .expect("active runs lock poisoned")
            .remove(request_id);
    }
}

struct ProviderEvents {
    app: AppHandle,
    event_name: String,
}

impl ProviderEvents {
    fn new(app: AppHandle, request_id: &str) -> Self {
        Self {
            app,
            event_name: format!("inference-lens://provider-turn/{request_id}"),
        }
    }

    fn emit(&self, event: &RawStreamEvent) {
        let _ = self.app.emit(&self.event_name, event);
    }
}

struct OutboundProviderRequest {
    endpoint: String,
    body: String,
    streaming: bool,
}

async fn execute_provider_turn(
    app: AppHandle,
    active_runs: ActiveRuns,
    request_id: String,
    request: OutboundProviderRequest,
    credential: ResolvedCredential,
    cancellation: CancellationToken,
) {
    let events = ProviderEvents::new(app, &request_id);
    stream_provider_turn(
        &events,
        &request.endpoint,
        request.body,
        request.streaming,
        credential.api_key.as_deref(),
        &cancellation,
    )
    .await;
    active_runs.remove(&request_id);
}

async fn stream_provider_turn(
    events: &ProviderEvents,
    endpoint: &str,
    body: String,
    streaming: bool,
    api_key: Option<&str>,
    cancellation: &CancellationToken,
) {
    let url = match chat_completions_url(endpoint) {
        Ok(url) => url,
        Err(message) => {
            events.emit(&RawStreamEvent::Error {
                kind: "transport",
                message,
                status: None,
            });
            return;
        }
    };

    let client = Client::new();
    let response = tokio::select! {
        _ = cancellation.cancelled() => {
            events.emit(&RawStreamEvent::Cancelled);
            return;
        }
        response = {
            let request = client
                .post(&url)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
            let request = match api_key {
                Some(api_key) => request.bearer_auth(api_key),
                None => request,
            };
            request.send()
        } => response,
    };
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            events.emit(&RawStreamEvent::Error {
                kind: "transport",
                message: format!("Could not reach provider: {error}"),
                status: None,
            });
            return;
        }
    };

    let status = response.status();
    let headers = response_headers(response.headers());
    events.emit(&RawStreamEvent::Response {
        status: status.as_u16(),
        headers,
    });
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        let message = if detail.is_empty() {
            format!("Provider returned HTTP {status}.")
        } else {
            detail.chars().take(4_000).collect()
        };
        events.emit(&RawStreamEvent::Error {
            kind: "provider",
            message,
            status: Some(status.as_u16()),
        });
        return;
    }

    if !streaming {
        let body = tokio::select! {
            _ = cancellation.cancelled() => {
                events.emit(&RawStreamEvent::Cancelled);
                return;
            }
            body = response.text() => body,
        };
        match body {
            Ok(body) => events.emit(&RawStreamEvent::Body { body }),
            Err(error) => {
                events.emit(&RawStreamEvent::Error {
                    kind: "transport",
                    message: format!("Could not read provider response: {error}"),
                    status: None,
                });
                return;
            }
        }
        events.emit(&RawStreamEvent::End);
        return;
    }

    let mut stream = response.bytes_stream();
    let mut pending = Vec::new();
    loop {
        let chunk = tokio::select! {
            _ = cancellation.cancelled() => {
                events.emit(&RawStreamEvent::Cancelled);
                return;
            }
            next = stream.next() => next,
        };
        let Some(chunk) = chunk else { break };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                events.emit(&RawStreamEvent::Error {
                    kind: "transport",
                    message: format!("Provider stream failed: {error}"),
                    status: None,
                });
                return;
            }
        };
        pending.extend_from_slice(&chunk);
        let lines = drain_complete_lines(&mut pending);
        if !lines.is_empty() {
            events.emit(&RawStreamEvent::Lines { lines });
        }
    }
    if !pending.is_empty() {
        events.emit(&RawStreamEvent::Lines {
            lines: vec![String::from_utf8_lossy(&pending).into_owned()],
        });
    }
    events.emit(&RawStreamEvent::End);
}

/// Extracts complete newline-terminated lines (CR/LF stripped) from a byte
/// buffer, leaving any trailing partial line in `pending`. A network chunk
/// can split a multi-byte UTF-8 character, so bytes are buffered here and
/// only decoded once a complete line (bounded by an ASCII `\n`) is available
/// — decoding a raw chunk directly could corrupt a split codepoint.
fn drain_complete_lines(pending: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(newline) = pending.iter().position(|byte| *byte == b'\n') {
        let mut line = pending.drain(..=newline).collect::<Vec<_>>();
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        lines.push(String::from_utf8_lossy(&line).into_owned());
    }
    lines
}

fn response_headers(headers: &reqwest::header::HeaderMap) -> Value {
    const SENSITIVE_HEADERS: [&str; 8] = [
        "authorization",
        "cookie",
        "proxy-authorization",
        "set-cookie",
        "access-token",
        "refresh-token",
        "password",
        "secret",
    ];
    let mut result = serde_json::Map::new();
    for (name, value) in headers {
        let name = name.as_str().to_ascii_lowercase();
        let normalized = name
            .chars()
            .filter(|character| character.is_ascii_alphanumeric())
            .collect::<String>();
        let sensitive = normalized.contains("apikey")
            || SENSITIVE_HEADERS.iter().any(|candidate| {
                candidate
                    .chars()
                    .filter(|character| character.is_ascii_alphanumeric())
                    .eq(normalized.chars())
            });
        let value = if sensitive {
            "••••••••".to_owned()
        } else {
            value
                .to_str()
                .map(str::to_owned)
                .unwrap_or_else(|_| "<non-UTF-8>".to_owned())
        };
        result.insert(name, Value::String(value));
    }
    Value::Object(result)
}

fn chat_completions_url(endpoint: &str) -> Result<String, String> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    let parsed = Url::parse(trimmed)
        .map_err(|_| command_error("Endpoint must be a valid HTTP or HTTPS URL."))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(command_error("Endpoint must use HTTP or HTTPS."));
    }
    if parsed.path().ends_with("/chat/completions") {
        Ok(parsed.to_string())
    } else {
        Ok(format!("{trimmed}/chat/completions"))
    }
}

fn models_url(endpoint: &str) -> Result<String, String> {
    let mut parsed = Url::parse(endpoint.trim().trim_end_matches('/'))
        .map_err(|_| command_error("Endpoint must be a valid HTTP or HTTPS URL."))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(command_error("Endpoint must use HTTP or HTTPS."));
    }
    if parsed.path().ends_with("/chat/completions") {
        let path = parsed
            .path()
            .trim_end_matches("/chat/completions")
            .to_owned();
        parsed.set_path(&path);
    }
    parsed.set_path(&format!("{}/models", parsed.path().trim_end_matches('/')));
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ActiveRuns::default())
        .manage(ProjectWorkspaces::default())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            store_credential,
            credential_status,
            discover_models,
            start_provider_turn,
            cancel_provider_turn,
            open_project_workspace,
            create_project_workspace,
            save_project_workspace,
            save_run_trace,
            list_run_traces,
            read_run_trace,
            export_run_trace,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Inference Lens");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TemporaryProjectDirectory(PathBuf);

    impl TemporaryProjectDirectory {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("inference-lens-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).expect("create temporary project directory");
            Self(path)
        }
    }

    impl Drop for TemporaryProjectDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn writes_and_replaces_a_project_manifest() {
        let directory = TemporaryProjectDirectory::new();
        write_project_manifest(&directory.0, "{\"schemaVersion\":2}\n").expect("write project");
        assert_eq!(
            fs::read_to_string(project_manifest_path(&directory.0)).expect("read written project"),
            "{\"schemaVersion\":2}\n"
        );

        write_project_manifest(&directory.0, "{\"schemaVersion\":2,\"name\":\"Updated\"}\n")
            .expect("replace project");
        assert_eq!(
            fs::read_to_string(project_manifest_path(&directory.0)).expect("read replaced project"),
            "{\"schemaVersion\":2,\"name\":\"Updated\"}\n"
        );
    }

    #[test]
    fn creates_visible_git_protected_project_bundles() {
        let parent = TemporaryProjectDirectory::new();
        let bundle = create_project_bundle(
            &parent.0,
            "Prompt Lab.inference-lens",
            "{\"schemaVersion\":5}\n",
            true,
        )
        .expect("create protected bundle");
        assert_eq!(
            fs::read_to_string(bundle.join(".gitignore")).expect("read ignore file"),
            "*\n"
        );
        assert_eq!(
            fs::read_to_string(bundle.join(PROJECT_FILE_NAME)).expect("read manifest"),
            "{\"schemaVersion\":5}\n"
        );
    }

    #[test]
    fn project_bundle_git_protection_can_be_disabled() {
        let parent = TemporaryProjectDirectory::new();
        let bundle = create_project_bundle(
            &parent.0,
            "Shared.inference-lens",
            "{\"schemaVersion\":5}\n",
            false,
        )
        .expect("create unprotected bundle");
        assert!(!bundle.join(".gitignore").exists());
        assert!(bundle.join(PROJECT_FILE_NAME).exists());
    }

    #[test]
    fn rejects_unsafe_or_existing_project_bundle_names() {
        let parent = TemporaryProjectDirectory::new();
        assert!(
            create_project_bundle(&parent.0, "../escape.inference-lens", "{}\n", true).is_err()
        );
        create_project_bundle(&parent.0, "Taken.inference-lens", "{}\n", true)
            .expect("create first bundle");
        assert!(create_project_bundle(&parent.0, "Taken.inference-lens", "{}\n", true).is_err());
    }

    #[test]
    fn writes_run_traces_once_and_rejects_different_replacements() {
        let directory = TemporaryProjectDirectory::new();
        write_run_trace(&directory.0, "run_example-1", "{\"schemaVersion\":1}\n")
            .expect("write trace");
        let path = directory
            .0
            .join(TRACES_DIRECTORY_NAME)
            .join("run_example-1.json");
        assert_eq!(
            fs::read_to_string(path).expect("read written trace"),
            "{\"schemaVersion\":1}\n"
        );
        write_run_trace(&directory.0, "run_example-1", "{\"schemaVersion\":1}\n")
            .expect("idempotent trace write");
        assert!(write_run_trace(
            &directory.0,
            "run_example-1",
            "{\"schemaVersion\":1,\"changed\":true}\n"
        )
        .is_err());
    }

    #[test]
    fn lists_json_run_traces_in_stable_order() {
        let directory = TemporaryProjectDirectory::new();
        write_run_trace(&directory.0, "run_second", "second\n").expect("write second trace");
        write_run_trace(&directory.0, "run_first", "first\n").expect("write first trace");
        fs::write(
            directory.0.join(TRACES_DIRECTORY_NAME).join("notes.txt"),
            "ignore",
        )
        .expect("write unrelated file");

        let traces = read_run_traces(&directory.0).expect("list traces");
        assert_eq!(traces.len(), 2);
        assert_eq!(traces[0].file_name, "run_first.json");
        assert_eq!(traces[0].contents, "first\n");
        assert_eq!(traces[1].file_name, "run_second.json");
    }

    #[test]
    fn lists_no_traces_when_the_directory_is_absent() {
        let directory = TemporaryProjectDirectory::new();
        assert!(read_run_traces(&directory.0)
            .expect("list absent traces directory")
            .is_empty());
    }

    #[test]
    fn skips_listed_names_that_are_not_trace_artifacts() {
        let directory = TemporaryProjectDirectory::new();
        write_run_trace(&directory.0, "run_kept", "kept\n").expect("write trace");
        let traces = directory.0.join(TRACES_DIRECTORY_NAME);
        for ignored in [".hidden.json", "-leading.json", ".json", "notes.txt"] {
            fs::write(traces.join(ignored), "ignore").expect("write ignored file");
        }

        let listed = read_run_traces(&directory.0).expect("list traces");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].file_name, "run_kept.json");
    }

    #[test]
    fn reads_one_trace_by_its_listed_name() {
        let directory = TemporaryProjectDirectory::new();
        write_run_trace(&directory.0, "run_single", "single\n").expect("write trace");

        assert_eq!(
            read_single_run_trace(&directory.0, "run_single.json").expect("read trace"),
            "single\n"
        );
        assert!(read_single_run_trace(&directory.0, "run_missing.json").is_err());
    }

    #[test]
    fn refuses_trace_names_that_could_escape_the_traces_directory() {
        let directory = TemporaryProjectDirectory::new();
        fs::write(directory.0.join("secret.json"), "secret").expect("write secret");

        for escaping in [
            "../secret.json",
            "..%2Fsecret.json",
            "nested/run_a.json",
            "/etc/passwd",
            "run_a.json/../../secret.json",
        ] {
            assert!(
                read_single_run_trace(&directory.0, escaping).is_err(),
                "{escaping} should be refused"
            );
        }
    }

    #[test]
    fn rejects_run_ids_that_could_escape_the_traces_directory() {
        assert!(trace_file_name("run_../../secret").is_err());
        assert!(trace_file_name("other_example").is_err());
    }

    #[test]
    fn exports_a_trace_to_an_explicit_file() {
        let directory = TemporaryProjectDirectory::new();
        let path = directory.0.join("saved-trace.json");
        write_exported_trace(&path, "{\"schemaVersion\":1}\n").expect("export trace");
        assert_eq!(
            fs::read_to_string(path).expect("read exported trace"),
            "{\"schemaVersion\":1}\n"
        );
    }

    #[test]
    fn captures_response_headers_and_redacts_sensitive_values() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-request-id", "request-1".parse().expect("header"));
        headers.insert("set-cookie", "session=secret".parse().expect("header"));
        assert_eq!(
            response_headers(&headers),
            json!({
                "set-cookie": "••••••••",
                "x-request-id": "request-1",
            })
        );
    }

    #[test]
    fn deserializes_native_credential_selections_from_ipc() {
        let provided = serde_json::from_value::<CredentialSelection>(json!({
            "kind": "provided",
            "apiKey": "test-secret",
        }))
        .expect("deserialize provided credential");
        assert!(matches!(
            provided,
            CredentialSelection::Provided { api_key } if api_key == "test-secret"
        ));

        let stored = serde_json::from_value::<CredentialSelection>(json!({
            "kind": "native-keychain",
            "profileId": "test-profile",
        }))
        .expect("deserialize stored credential reference");
        assert!(matches!(
            stored,
            CredentialSelection::NativeKeychain { profile_id } if profile_id == "test-profile"
        ));

        let no_credential = serde_json::from_value::<CredentialSelection>(json!({
            "kind": "none",
        }))
        .expect("deserialize no credential selection");
        assert!(matches!(no_credential, CredentialSelection::None));
    }

    #[test]
    fn drains_only_complete_lines_leaving_a_partial_tail_buffered() {
        let mut pending = b"data: one\ndata: tw".to_vec();
        let lines = drain_complete_lines(&mut pending);
        assert_eq!(lines, vec!["data: one".to_owned()]);
        assert_eq!(pending, b"data: tw".to_vec());
    }

    #[test]
    fn drains_crlf_terminated_lines() {
        let mut pending = b"data: one\r\ndata: two\r\n".to_vec();
        let lines = drain_complete_lines(&mut pending);
        assert_eq!(lines, vec!["data: one".to_owned(), "data: two".to_owned()]);
        assert!(pending.is_empty());
    }

    /// A network chunk boundary can split a multi-byte UTF-8 character. This
    /// buffers the split emoji across two `drain_complete_lines` calls and
    /// asserts the reassembled line has no U+FFFD replacement character.
    #[test]
    fn buffers_a_line_split_mid_utf8_codepoint_until_it_completes() {
        let emoji = "🎉".as_bytes();
        let mut pending = b"data: hel".to_vec();
        pending.extend_from_slice(&emoji[..2]);
        assert!(drain_complete_lines(&mut pending).is_empty());

        pending.extend_from_slice(&emoji[2..]);
        pending.extend_from_slice(b"\n");
        let lines = drain_complete_lines(&mut pending);
        assert_eq!(lines, vec!["data: hel🎉".to_owned()]);
        assert!(!lines[0].contains('\u{FFFD}'));
        assert!(pending.is_empty());
    }

    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    struct TestKeychainItem {
        profile_id: String,
    }

    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    impl Drop for TestKeychainItem {
        fn drop(&mut self) {
            if let Ok(entry) = Entry::new(KEYCHAIN_SERVICE, &self.profile_id) {
                let _ = entry.delete_credential();
            }
        }
    }

    /// This deliberately exercises the real macOS Keychain backend. The item
    /// has a random account name and is removed even if an assertion fails.
    #[cfg(all(target_os = "macos", not(debug_assertions)))]
    #[test]
    fn persists_a_profile_credential_in_macos_keychain() {
        let profile_id = format!("inference-lens-test-{}", uuid::Uuid::new_v4());
        let _cleanup = TestKeychainItem {
            profile_id: profile_id.clone(),
        };
        let endpoint = "https://api.openai.com/v1".to_owned();

        store_credential(
            profile_id.clone(),
            endpoint.clone(),
            "test-secret".to_owned(),
        )
        .expect("store credential in macOS Keychain");

        let stored = credential_for(&profile_id, &endpoint)
            .expect("read credential back from macOS Keychain");
        assert_eq!(stored.api_key, "test-secret");
        assert_eq!(stored.approved_origin, "https://api.openai.com");
        assert!(credential_for(&profile_id, "https://example.com/v1").is_err());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn development_credentials_are_session_only() {
        let endpoint = "https://api.openai.com/v1";
        let credential = resolve_credential(
            CredentialSelection::Provided {
                api_key: "test-secret".to_owned(),
            },
            endpoint,
        )
        .expect("resolve session credential");

        assert_eq!(credential.api_key.as_deref(), Some("test-secret"));
        assert!(resolve_credential(
            CredentialSelection::NativeKeychain {
                profile_id: "test-profile".to_owned(),
            },
            endpoint,
        )
        .is_err());
        assert_eq!(
            resolve_credential(CredentialSelection::None, endpoint)
                .expect("resolve no credential")
                .api_key,
            None,
        );

        let status =
            credential_status("test-profile".to_owned(), endpoint.to_owned()).expect("get status");
        assert!(!status.can_persist);
        assert!(!status.is_stored);
        assert!(!status.is_approved_for_endpoint);
    }
}
