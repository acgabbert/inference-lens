/**
 * Global keyboard commands belong to the page only while no modal interaction
 * surface owns the user's attention. Modal owners expose that boundary through
 * the standard dialog contract instead of being enumerated by the route.
 */
export function modalOwnsKeyboardCommands(
  documentRoot: Pick<Document, "querySelector"> = document,
): boolean {
  return Boolean(
    documentRoot.querySelector('[role="dialog"][aria-modal="true"]'),
  );
}
