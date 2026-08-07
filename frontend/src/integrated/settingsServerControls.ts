import { logger } from '../utils/Logger';

/**
 * Inject Start / Stop / Restart / Kill controls into the Settings modal's
 * "BlueSky Server Connectivity" section (integrated build only).
 *
 * The buttons reuse the Server Log toolbar's data-bs-action / .bs-status hooks
 * so ProcessControlManager drives both surfaces, and anchor off the core
 * #server-ip-input so index.html needs no integrated-specific ids. No-op when
 * the section is missing or already injected.
 */
export function injectSettingsServerControls(): void {
    if (document.getElementById('bs-settings-controls')) return;

    const section = document
        .getElementById('server-ip-input')
        ?.closest('.settings-section');
    if (!section) {
        logger.warn(
            'integrated',
            'Connectivity section not found; Settings server controls disabled',
        );
        return;
    }

    const group = document.createElement('div');
    group.className = 'setting-group';
    group.id = 'bs-settings-controls';
    group.innerHTML = `
        <label>BlueSky Server Controls:</label>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <button type="button" class="btn-secondary" data-bs-action="start">Start</button>
            <button type="button" class="btn-secondary" data-bs-action="stop">Stop</button>
            <button type="button" class="btn-secondary" data-bs-action="restart">Restart</button>
            <button type="button" class="btn-secondary" data-bs-action="kill">Kill</button>
            <span class="bs-status" style="margin-left:4px;color:#888;">unknown</span>
        </div>
        <small class="setting-help">Start, stop, restart, or kill the BlueSky server bundled with WebATM Integrated.</small>
    `;
    section.appendChild(group);
}
