/**
 * Whether the API service is running inside a container. The browser cannot
 * work this out for itself, and two of this project's worst onboarding
 * failures — a provider address that resolves to the container's own loopback,
 * and a page opened on the `0.0.0.0` address the server logs — can only be
 * explained precisely once it is known.
 *
 * The filesystem and environment are passed in rather than read directly so the
 * detection is testable off a container, matching how `EnvironmentCredentialStore`
 * takes its environment.
 */
export interface ContainerRuntimeProbe {
  fileExists(path: string): boolean;
  readFile(path: string): string | undefined;
  environment: Record<string, string | undefined>;
}

/** Set by every container runtime that implements the Kubernetes downward API. */
const KUBERNETES_MARKER = "KUBERNETES_SERVICE_HOST";

const CGROUP_MARKERS = ["docker", "containerd", "kubepods", "podman", "lxc"];

/**
 * Stated outright by this project's own image, and available to anyone else as
 * an override. The heuristics below are the standard way to identify an
 * *arbitrary* container, but they are still heuristics — cgroup markers are
 * unreliable under cgroup v2 — and they answer the wrong question under
 * `--network host`, where loopback really does reach the host's providers.
 */
const CONTAINER_OVERRIDE = "INFERENCE_LENS_CONTAINER";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function detectContainerRuntime(probe: ContainerRuntimeProbe): boolean {
  const declared = probe.environment[CONTAINER_OVERRIDE]?.trim().toLowerCase();
  if (declared && TRUE_VALUES.has(declared)) return true;
  if (declared && FALSE_VALUES.has(declared)) return false;

  // Docker writes this file into every container it creates. Podman writes
  // /run/.containerenv for the same purpose.
  if (probe.fileExists("/.dockerenv") || probe.fileExists("/run/.containerenv")) {
    return true;
  }

  // PID 1 in a container belongs to a scoped cgroup rather than the root one.
  // Absent on a host, and on cgroup v2 hosts the file holds only `0::/`.
  const cgroup = probe.readFile("/proc/1/cgroup")?.toLowerCase();
  if (cgroup && CGROUP_MARKERS.some((marker) => cgroup.includes(marker))) {
    return true;
  }

  return Boolean(probe.environment[KUBERNETES_MARKER]?.trim());
}
