import { AUTO_MODEL_SENTINEL } from './aircraftCategories';
import { logger } from '../utils/Logger';

/**
 * Shared access to the 3D aircraft model catalog. Both the Display
 * Options panel (global model setting) and the Aircraft Info panel
 * (per-aircraft override) need the /api/aircraft/models list and an
 * "Auto + models" dropdown; they used to carry separate copies.
 */

export interface AircraftModelOption {
    filename: string;
    displayName: string;
}

let cachedModels: AircraftModelOption[] | null = null;

/**
 * Fetch the available 3D models, caching the result so the catalog is
 * only requested once per page load. Returns [] on failure.
 */
export async function fetchAircraftModels(): Promise<AircraftModelOption[]> {
    if (cachedModels) return cachedModels;

    try {
        const response = await fetch('/api/aircraft/models');
        if (!response.ok) {
            logger.warn('aircraftModels', 'Failed to fetch aircraft models');
            return [];
        }
        const data = await response.json();
        if (data.success && Array.isArray(data.models)) {
            cachedModels = data.models.map((m: AircraftModelOption) => ({
                filename: m.filename,
                displayName: m.displayName,
            }));
            return cachedModels!;
        }
        return [];
    } catch (error) {
        logger.error('aircraftModels', `Error loading aircraft models: ${error}`);
        return [];
    }
}

/** Drop the cache (used by tests). */
export function resetAircraftModelsCache(): void {
    cachedModels = null;
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

    // "Auto" sentinel: use per-type category-based model selection
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
