# Links to saved runs

Open a saved chat or decision run in **Runs**, then choose **Copy link**. A saved
ordinary result in Compose or a saved experiment member also offers Copy link.
A link identifies one run in one project; it opens immutable evidence in Runs,
with diagnostics available, and preserves the current Compose session. It never
runs the model again.

Links look like:

```text
http://localhost:3000/#/run/v1?project=project_example&run=run_example
```

The app uses its current browser address, including the port and any supported
base path. The fragment is resolved in the browser, so no additional server
route or Docker project volume is required. Project and trace formats are
unchanged.

## Opening a link

Use Chrome or Edge with project folder access. The Docker container or other
browser deployment must be running and reachable before a clicked link can
load the app. Use one consistent address: `localhost`, `127.0.0.1`, and different
ports have separate browser storage and separate tab coordination.

The browser remembers previously accepted project folders locally. Opening a
link uses the matching open folder, or finds a remembered folder with the same
project ID. If several copies are registered, choose which copy to inspect.
This registry lives in the browser's IndexedDB, outside the project folder.

After a browser restart, **Reconnect** may be necessary to grant folder access
again. **Locate project folder…** handles moved folders, a new browser, cleared
site data, and a different machine. Picking the wrong project explains the ID
mismatch and leaves the current project intact. Cancelling keeps the reference
available to retry or dismiss; **Forget location** removes only the local hint.

If another tab is editing the project, the link opens in that tab when it
answers. The new tab explains where to look and offers **Open here instead**.
Opening here does not take over the editor role. If no tab answers, resolution
continues locally.

Switching projects uses the normal Save/Discard/Cancel protection. Active or
paused runs, executing batches and pending branches defer replacement. Saved
evidence in the current folder can be inspected while that work continues.

**Run data → Open saved run link…** accepts a pasted browser link, including one
copied from another deployment address. It also understands the proposed
`inference-lens://run/v1?project=…&run=…` spelling; launching the desktop app from
that scheme is deferred.

## What must be saved

Copy link requires evidence successfully written to or read from a project
folder. Copying revalidates the folder's project ID and the exact saved run.
Live or paused runs, session-only results, imported project JSON without a
folder, and loose trace downloads do not establish a reopenable project run.
Copying does not save or move evidence. If the clipboard is unavailable, a
selectable link appears for manual copying.

A link does not upload a trace or grant access to files. Another device needs
the matching project folder and trace. Git's definitions-only policy may
exclude run history: restore or copy the saved trace into the matching project
folder and choose **Retry**. A missing trace is never replaced with a new model
request.

Canonical `traces/<runId>.json` files are validated first. A missing canonical
file can resolve to one renamed trace with the same parsed run ID. A corrupt or
mismatched canonical file is an error, and multiple renamed matches require
repairing the duplicate evidence. The app never silently chooses another run.
