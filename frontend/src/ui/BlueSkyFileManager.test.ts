// @vitest-environment happy-dom
/**
 * Integrated-mode behavior for BlueSkyFileManager.
 *
 * In the integrated build the backend wires file management straight to
 * BlueSky's working directory, so the manual "BlueSky Base Directory"
 * configuration controls are hidden. The default build leaves them in place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function buildDom(): void {
    // Enough of the file-manager DOM for the singleton to construct without
    // throwing (it reads file-type-select on init), plus the base-path config
    // group enableIntegratedMode() targets.
    document.body.innerHTML = `
        <select id="file-type-select"><option value="scenario">Scenario</option></select>
        <input id="file-input" />
        <button id="upload-and-run-scenario-btn"></button>
        <div class="settings-section">
            <div class="section-header">
                <h4>BlueSky File Management</h4>
                <div class="section-description">Configure BlueSky base directory for file uploads and management</div>
            </div>
            <div class="setting-group" id="cfg-group">
                <label for="bluesky-base-path-input-settings">BlueSky Base Directory:</label>
                <input type="text" id="bluesky-base-path-input-settings" />
                <button id="configure-base-path-btn-settings">Configure</button>
            </div>
            <div id="base-path-status-settings" style="display: none;"></div>
        </div>
    `;
}

describe('BlueSkyFileManager integrated mode', () => {
    beforeEach(() => {
        vi.resetModules(); // fresh singleton per test
        buildDom();
        // The singleton fires checkCurrentStatus() (a fetch) on construction;
        // report "not configured" so it takes the null-safe unconfigured path.
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ json: async () => ({ configured: false }) }),
        );
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('hides the base-path configuration group when enabled', async () => {
        const { blueSkyFileManager } = await import('./BlueSkyFileManager');

        const group = document.getElementById('cfg-group') as HTMLElement;
        expect(group.style.display).not.toBe('none');

        blueSkyFileManager.enableIntegratedMode();

        await vi.waitFor(() => expect(group.style.display).toBe('none'));

        // The "Configure …" wording is replaced with an auto-configured note.
        const description = document.querySelector('.section-description');
        expect(description?.textContent).not.toMatch(/Configure BlueSky base directory/);
        expect(description?.textContent).toMatch(/configured automatically/i);
    });

    it('leaves the configuration group visible in the default build', async () => {
        const { blueSkyFileManager } = await import('./BlueSkyFileManager');

        // Without enableIntegratedMode() the manual config stays put.
        const group = document.getElementById('cfg-group') as HTMLElement;
        expect(group.style.display).not.toBe('none');
        expect(typeof blueSkyFileManager.enableIntegratedMode).toBe('function');
    });

    it('is idempotent', async () => {
        const { blueSkyFileManager } = await import('./BlueSkyFileManager');
        const group = document.getElementById('cfg-group') as HTMLElement;

        blueSkyFileManager.enableIntegratedMode();
        blueSkyFileManager.enableIntegratedMode(); // second call is a no-op

        await vi.waitFor(() => expect(group.style.display).toBe('none'));
    });
});
