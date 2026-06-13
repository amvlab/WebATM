/**
 * Shared visual update for a status-indicator + status-text element pair.
 * Used by ServerManager and Controls (and anywhere else that renders a
 * "status pill" using the existing status-{running,stopped,…} CSS classes).
 *
 * Owners keep their own bookkeeping (event dispatch, state updates,
 * button-state recompute); this helper handles just the DOM plumbing so
 * the "remove all status-* classes, add status-${x}" block lives in one
 * place.
 */

const DEFAULT_STATUS_CLASSES = [
    'status-running',
    'status-stopped',
    'status-unknown',
    'status-starting',
    'status-stopping',
    'status-restarting'
];

export class StatusDisplayManager {
    constructor(
        private readonly textElement: HTMLElement | null,
        private readonly indicatorElement: HTMLElement | null,
        private readonly knownStatusClasses: string[] = DEFAULT_STATUS_CLASSES
    ) {}

    update(message: string, status: string): void {
        if (this.textElement) {
            this.textElement.textContent = message;
        }
        if (this.indicatorElement) {
            for (const cls of this.knownStatusClasses) {
                this.indicatorElement.classList.remove(cls);
            }
            this.indicatorElement.classList.add(`status-${status}`);
        }
    }
}
