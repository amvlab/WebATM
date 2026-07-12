import { AUTO_MODEL_SENTINEL } from './aircraftCategories';
import { logger } from '../utils/Logger';

/**
 * Shared access to the 3D aircraft model catalog. Both the Display
 * Options panel (global model setting) and the Aircraft Info panel
 * (per-aircraft override) need the /api/aircraft/models list and an
 * "Auto + models" dropdown.
 */

export interface AircraftModelOption {
    filename: string;
    displayName: string;
}

let catalogPromise: Promise<AircraftModelOption[]> | null = null;

/**
 * Fetch the available 3D models. The in-flight promise is cached so
 * concurrent callers (both panels initialize at startup) share a single
 * request per page load. Returns [] on failure without caching it, so a
 * later call retries.
 */
export function fetchAircraftModels(): Promise<AircraftModelOption[]> {
    if (!catalogPromise) {
        const promise: Promise<AircraftModelOption[]> = requestModels().then((models) => {
            if (models === null) {
                // Only clear our own entry — a reset may have started a
                // newer request while this one was failing.
                if (catalogPromise === promise) catalogPromise = null;
                return [];
            }
            return models;
        });
        catalogPromise = promise;
    }
    return catalogPromise;
}

/** One catalog request; null signals failure (as opposed to an empty catalog). */
async function requestModels(): Promise<AircraftModelOption[] | null> {
    try {
        const response = await fetch('/api/aircraft/models');
        if (!response.ok) {
            logger.warn('aircraftModels', 'Failed to fetch aircraft models');
            return null;
        }
        const data = await response.json();
        if (data.success && Array.isArray(data.models)) {
            return data.models.map((m: AircraftModelOption) => ({
                filename: m.filename,
                displayName: m.displayName,
            }));
        }
        return null;
    } catch (error) {
        logger.error('aircraftModels', `Error loading aircraft models: ${error}`);
        return null;
    }
}

/** Drop the cache (used by tests). */
export function resetAircraftModelsCache(): void {
    catalogPromise = null;
}

/**
 * Rebuild a model <select> as the "Auto" sentinel plus every known
 * model, then select `selected` — falling back to Auto when it is
 * neither the sentinel nor a known model file.
 */
export function populateModelSelect(
    select: HTMLSelectElement,
    models: AircraftModelOption[],
    selected: string = AUTO_MODEL_SENTINEL
): void {
    select.innerHTML = '';

    const autoOption = document.createElement('option');
    autoOption.value = AUTO_MODEL_SENTINEL;
    autoOption.textContent = 'Auto (by aircraft type)';
    select.appendChild(autoOption);

    for (const model of models) {
        const option = document.createElement('option');
        option.value = model.filename;
        option.textContent = model.displayName;
        select.appendChild(option);
    }

    const hasSelected = selected === AUTO_MODEL_SENTINEL
        || models.some(m => m.filename === selected);
    select.value = hasSelected ? selected : AUTO_MODEL_SENTINEL;
}
