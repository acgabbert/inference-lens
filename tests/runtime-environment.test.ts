import assert from "node:assert/strict";
import test from "node:test";

import { detectContainerRuntime } from "../services/api/src/runtime-environment.ts";

function probe(input: {
  files?: Record<string, string>;
  environment?: Record<string, string | undefined>;
}) {
  const files = input.files ?? {};
  return {
    environment: input.environment ?? {},
    fileExists: (path: string) => path in files,
    readFile: (path: string) => files[path],
  };
}

test("detects a Docker container from the marker file it writes", () => {
  assert.equal(
    detectContainerRuntime(probe({ files: { "/.dockerenv": "" } })),
    true,
  );
});

test("detects a Podman container from its own marker file", () => {
  assert.equal(
    detectContainerRuntime(probe({ files: { "/run/.containerenv": "" } })),
    true,
  );
});

test("detects a container from PID 1's scoped cgroup", () => {
  assert.equal(
    detectContainerRuntime(
      probe({
        files: {
          "/proc/1/cgroup":
            "0::/system.slice/docker-3f2b1a.scope\n12:pids:/docker/3f2b1a\n",
        },
      }),
    ),
    true,
  );
});

test("detects a Kubernetes pod from the injected service host", () => {
  assert.equal(
    detectContainerRuntime(
      probe({ environment: { KUBERNETES_SERVICE_HOST: "10.96.0.1" } }),
    ),
    true,
  );
});

test("reports a bare host as not containerized", () => {
  // A cgroup v2 host has the file, but PID 1 sits in the root cgroup.
  assert.equal(
    detectContainerRuntime(probe({ files: { "/proc/1/cgroup": "0::/\n" } })),
    false,
  );
  assert.equal(detectContainerRuntime(probe({})), false);
});

test("believes the image when it declares itself", () => {
  // Our own Dockerfile sets this, so the heuristics below never have to be
  // right for the image we ship.
  assert.equal(
    detectContainerRuntime(probe({ environment: { INFERENCE_LENS_CONTAINER: "1" } })),
    true,
  );
});

test("lets an explicit denial outrank every marker", () => {
  // `--network host` leaves the markers in place while making the container's
  // loopback the host's, so the advice they drive would be wrong.
  assert.equal(
    detectContainerRuntime(
      probe({
        files: { "/.dockerenv": "" },
        environment: { INFERENCE_LENS_CONTAINER: "false" },
      }),
    ),
    false,
  );
});

test("falls back to detection for a value it cannot read", () => {
  assert.equal(
    detectContainerRuntime(
      probe({
        files: { "/.dockerenv": "" },
        environment: { INFERENCE_LENS_CONTAINER: "maybe" },
      }),
    ),
    true,
  );
});

test("treats a blank Kubernetes service host as absent", () => {
  assert.equal(
    detectContainerRuntime(probe({ environment: { KUBERNETES_SERVICE_HOST: "  " } })),
    false,
  );
});
