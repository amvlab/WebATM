/**
 * Aircraft Shape Definitions
 *
 * This file contains different aircraft shape drawing functions for the map display.
 * Each shape is designed to point upward and will be rotated by MapLibre based on aircraft heading.
 */

import { AircraftShapeDrawer } from './AircraftRenderer';

/**
 * Chevron shape (default)
 * Classic air traffic control chevron with tail notch
 */
// export const drawChevronShape: AircraftShapeDrawer = (ctx, size) => {
//     ctx.beginPath();
//     ctx.moveTo(size / 2, 8);           // Top point
//     ctx.lineTo(size / 2 - 8, size - 8); // Bottom left
//     ctx.lineTo(size / 2, size - 12);    // Bottom center notch
//     ctx.lineTo(size / 2 + 8, size - 8); // Bottom right
//     ctx.closePath();
// };

/**
 * Simple arrow shape
 * Clean arrow with defined tail - proportional to canvas size
 */
export const drawChevronShape: AircraftShapeDrawer = (ctx, size) => {
    const c = size / 2;
    const margin = size * 0.15;        // 15% margin from edges
    const width = size * 0.3;          // 30% width on each side
    const notch = size * 0.12;         // 12% tail notch depth

    ctx.beginPath();
    ctx.moveTo(c, margin);                  // Top point
    ctx.lineTo(c - width, size - margin);   // Bottom left
    ctx.lineTo(c, size - margin - notch);   // Bottom center (tail notch)
    ctx.lineTo(c + width, size - margin);   // Bottom right
    ctx.closePath();
};

/**
 * Simple triangle shape
 * Basic triangle pointing upward - proportional to canvas size
 */
export const drawTriangleShape: AircraftShapeDrawer = (ctx, size) => {
    const c = size / 2;
    const margin = size * 0.15;        // 15% margin from edges
    const width = size * 0.3;          // 30% width on each side

    ctx.beginPath();
    ctx.moveTo(c, margin);                  // Top point
    ctx.lineTo(c - width, size - margin);   // Bottom left
    ctx.lineTo(c + width, size - margin);   // Bottom right
    ctx.closePath();
};

/**
 * Aircraft silhouette with wings
 * Simple but recognizable airplane shape with fuselage, wings, and tail
 */
export const drawAircraftShape: AircraftShapeDrawer = (ctx, size) => {
    const c = size / 2;

    // Define proportions
    const noseY = size * 0.1;           // Nose position
    const wingY = size * 0.42;          // Wing position
    const tailY = size * 0.85;          // Tail position
    const wingSpan = size * 0.4;        // Wing span (half width)
    const fuselageWidth = size * 0.06;  // Fuselage width (half)
    const tailSpan = size * 0.22;       // Tail span (half width)
    const tailWidth = size * 0.05;      // Tail thickness

    ctx.beginPath();

    // Start at nose tip
    ctx.moveTo(c, noseY);

    // Right side of fuselage to wing leading edge
    ctx.lineTo(c + fuselageWidth, wingY - size * 0.02);

    // Right wing - swept back leading edge
    ctx.lineTo(c + wingSpan, wingY + size * 0.08);
    // Wing trailing edge
    ctx.lineTo(c + wingSpan * 0.85, wingY + size * 0.12);

    // Back to right fuselage
    ctx.lineTo(c + fuselageWidth, wingY + size * 0.06);

    // Right fuselage to tail
    ctx.lineTo(c + fuselageWidth * 0.8, tailY - size * 0.08);

    // Right horizontal stabilizer
    ctx.lineTo(c + tailSpan, tailY);
    ctx.lineTo(c + tailSpan * 0.8, tailY + tailWidth);
    ctx.lineTo(c + fuselageWidth * 0.5, tailY - size * 0.02);

    // Tail tip
    ctx.lineTo(c, tailY);

    // Mirror for left side
    // Left horizontal stabilizer
    ctx.lineTo(c - fuselageWidth * 0.5, tailY - size * 0.02);
    ctx.lineTo(c - tailSpan * 0.8, tailY + tailWidth);
    ctx.lineTo(c - tailSpan, tailY);

    // Left fuselage from tail
    ctx.lineTo(c - fuselageWidth * 0.8, tailY - size * 0.08);
    ctx.lineTo(c - fuselageWidth, wingY + size * 0.06);

    // Left wing trailing edge
    ctx.lineTo(c - wingSpan * 0.85, wingY + size * 0.12);
    // Left wing leading edge
    ctx.lineTo(c - wingSpan, wingY + size * 0.08);

    // Back to left fuselage
    ctx.lineTo(c - fuselageWidth, wingY - size * 0.02);

    // Complete the shape back to nose
    ctx.closePath();
    ctx.fill();
};


/**
 * Drone shape with rotors
 * Quadcopter with central body, four rotors in X configuration, and directional indicator
 */
export const drawDroneShape: AircraftShapeDrawer = (ctx, size) => {
    const c = size / 2;
    const armLength = size * 0.32;
    const armWidth = size * 0.04;
    const bodySize = size * 0.15;
    const rotorRadius = size * 0.08;
    const angle = Math.PI / 4; // 45 degrees for X configuration

    // Proportional stroke width (thinner border)
    const strokeWidth = Math.max(1, size / 48);

    // Calculate rotor positions (diagonal X pattern)
    const rotorPositions = [
        [c - armLength * Math.cos(angle), c - armLength * Math.sin(angle)], // Front left
        [c + armLength * Math.cos(angle), c - armLength * Math.sin(angle)], // Front right
        [c + armLength * Math.cos(angle), c + armLength * Math.sin(angle)], // Back right
        [c - armLength * Math.cos(angle), c + armLength * Math.sin(angle)]  // Back left
    ];

    // Draw arms with white stroke (diagonal lines)
    ctx.lineWidth = armWidth;
    ctx.lineCap = 'round';

    // White border for arms (thinner)
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = armWidth + strokeWidth;
    for (const [x, y] of rotorPositions) {
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.lineTo(x, y);
        ctx.stroke();
    }

    // Colored arms
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = armWidth;
    for (const [x, y] of rotorPositions) {
        ctx.beginPath();
        ctx.moveTo(c, c);
        ctx.lineTo(x, y);
        ctx.stroke();
    }

    // Draw rotors (4 circles at arm ends) with white stroke
    for (const [x, y] of rotorPositions) {
        // White border (thinner)
        ctx.beginPath();
        ctx.arc(x, y, rotorRadius, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = strokeWidth;
        ctx.stroke();
        ctx.fill();
    }

    // Draw central body with white stroke (thinner)
    ctx.beginPath();
    ctx.arc(c, c, bodySize, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
    ctx.fill();

    // Draw directional indicator (small arrow pointing up/forward)
    const arrowSize = size * 0.12;
    const arrowY = c - bodySize - size * 0.15; // Above the body (further away)
    ctx.beginPath();
    ctx.moveTo(c, arrowY - arrowSize);           // Arrow tip (top)
    ctx.lineTo(c - arrowSize * 0.5, arrowY);     // Left base
    ctx.lineTo(c, arrowY - arrowSize * 0.4);     // Center notch
    ctx.lineTo(c + arrowSize * 0.5, arrowY);     // Right base
    ctx.closePath();

    // White border for arrow (thinner)
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = strokeWidth;
    ctx.stroke();
    ctx.fill();
};

/**
 * Available aircraft shapes with display names
 */
export const AIRCRAFT_SHAPES = {
    chevron: { name: 'Chevron', drawer: drawChevronShape },
    triangle: { name: 'Triangle', drawer: drawTriangleShape },
    aircraft: { name: 'Aircraft', drawer: drawAircraftShape },
    drone: { name: 'Drone', drawer: drawDroneShape }
} as const;

export type AircraftShapeType = keyof typeof AIRCRAFT_SHAPES;
