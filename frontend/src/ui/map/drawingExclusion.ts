/**
 * Mutual exclusion between the map's click-to-draw tools (route drawing,
 * shape drawing, aircraft placement). Each tool claims the map when its
 * interactive mode starts; claiming cancels whichever tool held it, so two
 * tools can never consume the same map clicks at once.
 */

let activeOwner: object | null = null;
let activeCancel: (() => void) | null = null;

/**
 * Claim interactive drawing for `owner`, cancelling any other tool's
 * in-progress draw first. `cancel` must fully stop the owner's draw; it is
 * invoked when another tool claims the map.
 */
export function claimDrawing(owner: object, cancel: () => void): void {
    if (activeOwner && activeOwner !== owner) {
        activeCancel?.();
    }
    activeOwner = owner;
    activeCancel = cancel;
}

/** Release the claim if `owner` still holds it (no-op otherwise). */
export function releaseDrawing(owner: object): void {
    if (activeOwner === owner) {
        activeOwner = null;
        activeCancel = null;
    }
}
