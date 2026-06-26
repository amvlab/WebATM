/**
 * Guards the aircraft-shape catalogue against drift.
 *
 * `AIRCRAFT_SHAPES` (the runtime catalogue) and `AircraftShapeType` (the union
 * in data/types.ts) are two independent sources of truth: data/types.ts cannot
 * import this UI module without a circular dependency, so the union is declared
 * by hand. These tests fail if the two ever diverge.
 */
import { describe, it, expect } from 'vitest';
import { AIRCRAFT_SHAPES } from './AircraftShapes';
import type { AircraftShapeType } from '../../../data/types';

// Compile-time guard (verified by `tsc --noEmit`): the catalogue keys and the
// AircraftShapeType union must cover each other exactly. If either gains a
// member the other lacks, one of these assignments becomes `never` and fails.
type KeysCoverUnion = AircraftShapeType extends keyof typeof AIRCRAFT_SHAPES ? true : never;
type UnionCoversKeys = keyof typeof AIRCRAFT_SHAPES extends AircraftShapeType ? true : never;
const _keysCoverUnion: KeysCoverUnion = true;
const _unionCoversKeys: UnionCoversKeys = true;
void _keysCoverUnion;
void _unionCoversKeys;

describe('AIRCRAFT_SHAPES', () => {
    it('gives every shape a display name and a drawer function', () => {
        for (const [key, config] of Object.entries(AIRCRAFT_SHAPES)) {
            expect(config.name, `${key} name`).toBeTruthy();
            expect(typeof config.drawer, `${key} drawer`).toBe('function');
        }
    });

    it('keeps chevron available as the default shape', () => {
        expect(AIRCRAFT_SHAPES.chevron?.drawer).toBeTypeOf('function');
    });
});
