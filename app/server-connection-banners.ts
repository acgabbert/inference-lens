import { protocolConfigurationNames } from "../packages/core/src/provider-protocols.ts";
import { DEFAULT_SERVER_CONNECTION_ID } from "../packages/core/src/server-connection-catalog.ts";
import type { AppBanner } from "./notifications/banner-priority.client.ts";
import type { ConnectionProfilesHandle } from "./use-connection-profiles.client.ts";

function quoted(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

/**
 * The page-level notices about the server's connections, highest priority
 * first: a configuration that was ignored outranks an offer of a new profile.
 * Each is the route's to place among the other banners, and the drawer's to
 * open; everything else about them belongs to the connection profiles.
 */
export function serverConnectionBanners(
  handle: Pick<
    ConnectionProfilesHandle,
    | "serverProtocolsNotice"
    | "dismissServerProtocolsNotice"
    | "serverCatalogNotice"
    | "dismissServerCatalogNotice"
    | "serverProfilesNotice"
    | "adoptServerProfile"
    | "dismissServerProfilesNotice"
  >,
  openConnections: () => void,
): (AppBanner | undefined)[] {
  return [
    protocolsBanner(handle, openConnections),
    catalogBanner(handle),
    profilesBanner(handle, openConnections),
  ];
}

function protocolsBanner(
  {
    serverProtocolsNotice: notice,
    dismissServerProtocolsNotice: dismiss,
  }: Pick<ConnectionProfilesHandle, "serverProtocolsNotice" | "dismissServerProtocolsNotice">,
  openConnections: () => void,
): AppBanner | undefined {
  if (!notice) return undefined;
  const accepted = protocolConfigurationNames().join(", ");
  const [only] = notice.connections;
  const legacyOnly =
    notice.connections.length === 1 && only!.id === DEFAULT_SERVER_CONNECTION_ID;
  // The legacy variable is read once at start; the catalog on every request.
  const remedy = notice.connections.some(({ id }) => id === DEFAULT_SERVER_CONNECTION_ID)
    ? "restart the server"
    : "reload this page";
  return {
    id: "server-protocols-invalid",
    tone: "advisory",
    title: legacyOnly
      ? "INFERENCE_LENS_API_PROTOCOLS was ignored"
      : notice.connections.length === 1
        ? `The protocol list for "${only!.name}" was ignored`
        : "Server connection protocol lists were ignored",
    detail: legacyOnly
      ? `It names ${quoted(only!.unrecognized)}, which ${
          only!.unrecognized.length === 1 ? "is" : "are"
        } not a recognized API, so the server default profile falls back to the APIs enabled in Connections. Use ${accepted} and restart the server.`
      : `${notice.connections
          .map(
            ({ id, name, unrecognized }) =>
              `${id === DEFAULT_SERVER_CONNECTION_ID ? "INFERENCE_LENS_API_PROTOCOLS" : `"${name}"`} names ${quoted(unrecognized)}`,
          )
          .join("; ")}, which the server does not recognize, so those profiles fall back to the APIs enabled in Connections. Use ${accepted} and ${remedy}.`,
    actions: [
      {
        key: "review",
        label: "Review Connections",
        primary: true,
        onSelect: () => {
          dismiss();
          openConnections();
        },
      },
      { key: "dismiss", label: "Dismiss", onSelect: dismiss },
    ],
  };
}

function catalogBanner({
  serverCatalogNotice: notice,
  dismissServerCatalogNotice: dismiss,
}: Pick<ConnectionProfilesHandle, "serverCatalogNotice" | "dismissServerCatalogNotice">):
  | AppBanner
  | undefined {
  if (!notice) return undefined;
  return {
    id: "server-catalog-invalid",
    tone: "advisory",
    title: "The server's connection catalog was refused",
    detail: `${notice.problem} None of its connections are available until INFERENCE_LENS_CONNECTIONS is fixed; the profiles they provisioned are kept as they were. Reload this page once it is.`,
    actions: [{ key: "dismiss", label: "Dismiss", onSelect: dismiss }],
  };
}

function profilesBanner(
  {
    serverProfilesNotice: notice,
    adoptServerProfile: adopt,
    dismissServerProfilesNotice: dismiss,
  }: Pick<
    ConnectionProfilesHandle,
    "serverProfilesNotice" | "adoptServerProfile" | "dismissServerProfilesNotice"
  >,
  openConnections: () => void,
): AppBanner | undefined {
  if (!notice || notice.profiles.length === 0) return undefined;
  const [first] = notice.profiles;
  const single = notice.profiles.length === 1;
  const legacyOnly = single && first!.id === "server-default";
  return {
    id: "server-default-profile",
    tone: "advisory",
    title: legacyOnly
      ? "Server default connection available"
      : single
        ? `Server connection "${first!.name}" available`
        : "Server connections available",
    detail: single
      ? legacyOnly
        ? "A profile using this server's configured endpoint was added to Connections."
        : `A profile using a connection this server holds a key for was added to Connections.`
      : `Profiles for ${quoted(notice.profiles.map(({ name }) => name))} were added to Connections.`,
    actions: [
      {
        key: "use",
        label: single ? "Use it" : `Use "${first!.name}"`,
        primary: true,
        onSelect: adopt,
      },
      {
        key: "review",
        label: "Review",
        onSelect: () => {
          dismiss();
          openConnections();
        },
      },
      { key: "dismiss", label: "Dismiss", onSelect: dismiss },
    ],
  };
}
