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
    // group enableIntegratedMode() targets and the drag-and-drop zone.
    document.body.innerHTML = `
        <select id="file-type-select"><option value="scenario">Scenario</option></select>
        <input id="file-input" />
        <div id="file-drop-zone"></div>
        <button id="upload-file-btn"></button>
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

describe('BlueSkyFileManager drop zone highlight', () => {
    beforeEach(() => {
        vi.resetModules();
        buildDom();
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

    async function ready(): Promise<HTMLElement> {
        await import('./BlueSkyFileManager');
        return document.getElementById('file-drop-zone') as HTMLElement;
    }

    it('adds the drag-over class on dragover and removes it on dragleave', async () => {
        const zone = await ready();

        zone.dispatchEvent(new Event('dragover', { bubbles: true }));
        expect(zone.classList.contains('drag-over')).toBe(true);

        // Leaving without dropping must clear the highlight (the bug: it stuck on).
        zone.dispatchEvent(new Event('dragleave', { bubbles: true }));
        expect(zone.classList.contains('drag-over')).toBe(false);
    });

    it('clears the highlight on dragend', async () => {
        const zone = await ready();

        zone.dispatchEvent(new Event('dragover', { bubbles: true }));
        zone.dispatchEvent(new Event('dragend', { bubbles: true }));
        expect(zone.classList.contains('drag-over')).toBe(false);
    });

    it('clears the highlight after a drop and adds no inline color overrides', async () => {
        const zone = await ready();

        zone.dispatchEvent(new Event('dragover', { bubbles: true }));
        zone.dispatchEvent(new Event('drop', { bubbles: true }));

        expect(zone.classList.contains('drag-over')).toBe(false);
        // The old code hardcoded borderColor/backgroundColor on drop, which
        // permanently overrode the themed base style; the class-based fix leaves
        // no inline colors behind.
        expect(zone.style.backgroundColor).toBe('');
        expect(zone.style.borderColor).toBe('');
    });
});
