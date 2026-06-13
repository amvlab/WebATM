// @vitest-environment happy-dom
/**
 * Tests for injecting the Start / Stop / Restart / Kill controls into the
 * Settings modal's "BlueSky Server Connectivity" section (integrated build).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { injectSettingsServerControls } from './settingsServerControls';

function buildConnectivitySection(): void {
    document.body.innerHTML = `
        <div class="settings-section">
            <div class="section-header"><h4>BlueSky Server Connectivity</h4></div>
            <div class="setting-group">
                <label for="server-ip-input">BlueSky Server hostname/IP address:</label>
                <input type="text" id="server-ip-input" value="localhost">
            </div>
        </div>
    `;
}

describe('injectSettingsServerControls', () => {
    beforeEach(() => buildConnectivitySection());
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('injects the four lifecycle controls + a status span into the connectivity section', () => {
        injectSettingsServerControls();

        const group = document.getElementById('bs-settings-controls');
        expect(group).not.toBeNull();
        // Lives inside the same section as the host input.
        expect(group?.closest('.settings-section')).toBe(
            document.getElementById('server-ip-input')?.closest('.settings-section'),
        );

        const actions = Array.from(group!.querySelectorAll('[data-bs-action]')).map(
            (el) => (el as HTMLElement).dataset.bsAction,
        );
        expect(actions).toEqual(['start', 'stop', 'restart', 'kill']);
        expect(group!.querySelector('.bs-status')).not.toBeNull();
    });

    it('is idempotent — a second call does not duplicate the controls', () => {
        injectSettingsServerControls();
        injectSettingsServerControls();

        expect(document.querySelectorAll('#bs-settings-controls')).toHaveLength(1);
        expect(document.querySelectorAll('[data-bs-action="start"]')).toHaveLength(1);
    });

    it('is a no-op when the connectivity section is absent', () => {
        document.body.innerHTML = '';
        expect(() => injectSettingsServerControls()).not.toThrow();
        expect(document.getElementById('bs-settings-controls')).toBeNull();
    });
});
