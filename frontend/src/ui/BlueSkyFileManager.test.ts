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
        <div id="upload-progress"><div id="upload-progress-bar"></div></div>
        <div id="upload-status"></div>
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

describe('BlueSkyFileManager upload uses the stored filename', () => {
    beforeEach(() => {
        vi.resetModules();
        buildDom();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    /** Fetch stub: uploads succeed with the backend's stored name (which can
     *  differ from the uploaded one — sanitization, auto-rename on conflict);
     *  everything else reports "not configured". */
    function stubFetch(storedFilename: string): void {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation(async (url: unknown) => ({
                json: async () =>
                    String(url).includes('/api/bluesky/upload/')
                        ? { success: true, filename: storedFilename }
                        : { configured: false },
            })),
        );
    }

    /** Stub a selected file, mirroring a real input: setting value = ''
     *  clears the selection. */
    function selectFile(name: string): void {
        const fileInput = document.getElementById('file-input') as HTMLInputElement;
        const file = new File(['00:00:00.00>CRE NEW1 A320 52 4 90 FL200 220'], name, {
            type: 'text/plain',
        });
        let files: File[] = [file];
        Object.defineProperty(fileInput, 'files', { get: () => files, configurable: true });
        Object.defineProperty(fileInput, 'value', {
            get: () => (files.length ? files[0].name : ''),
            set: (v: string) => { if (v === '') files = []; },
            configurable: true,
        });
    }

    it('runs the scenario under the name the backend stored it as', async () => {
        // Re-uploading demo.scn stores it as demo_1.scn; IC must run THAT
        // file, not the stale root namesake the original name points at. The
        // .scn extension is kept — BlueSky's IC forces one onto the name via
        // Path.with_suffix, so a stripped name must never lose a dot part.
        stubFetch('demo_1.scn');
        const sendCommand = vi.fn();
        vi.stubGlobal('app', { sendCommand });
        await import('./BlueSkyFileManager');

        selectFile('demo.scn');
        (document.getElementById('upload-and-run-scenario-btn') as HTMLButtonElement).click();

        await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledWith('IC demo_1.scn'));
    });

    it('keeps a dotted scenario name intact in the IC command', async () => {
        // "IC demo.v2" would be rewritten by BlueSky's Path.with_suffix to
        // "demo.scn" — a different (possibly stale) scenario. Sending the
        // full stored filename makes with_suffix a no-op.
        stubFetch('demo.v2.scn');
        const sendCommand = vi.fn();
        vi.stubGlobal('app', { sendCommand });
        await import('./BlueSkyFileManager');

        selectFile('demo.v2.scn');
        (document.getElementById('upload-and-run-scenario-btn') as HTMLButtonElement).click();

        await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledWith('IC demo.v2.scn'));
    });

    it('reports the stored name in the plain-upload success toast', async () => {
        stubFetch('demo_1.scn');
        await import('./BlueSkyFileManager');

        selectFile('demo.scn');
        (document.getElementById('upload-file-btn') as HTMLButtonElement).click();

        await vi.waitFor(() => {
            const status = document.getElementById('upload-status')?.textContent || '';
            expect(status).toContain('demo_1.scn');
        });
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
