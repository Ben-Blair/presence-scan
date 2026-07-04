// Immediate-mode debug view of the nav grid and the demo orbs' A* paths,
// following the sensor-overlay pattern: world-space lines drawn every frame,
// only while demo mode + the showNavDebug toggle are on. The blocked region is
// drawn as its boundary outline (edges between a blocked and a free cell)
// rather than per-cell boxes, keeping the line count low.

import { Vec3, Color } from 'playcanvas';

const COL_BLOCKED = new Color(1.0, 0.35, 0.3);
const COL_PATHS = [
    new Color(0.3, 1.0, 0.55),
    new Color(1.0, 0.75, 0.2),
    new Color(0.75, 0.45, 1.0)
];

export class NavDebugOverlay {
    /**
     * @param {*} app - pc app
     * @param {*} params - the shared live params object
     * @param {import('./nav-grid.js').NavGrid} grid
     * @param {import('./demo-wander.js').DemoWander} wander
     */
    constructor(app, params, grid, wander) {
        this.app = app;
        this.params = params;
        this.wander = wander;
        /** @type {Vec3[][]} pre-built [from, to] outline segments */
        this._outline = [];
        this._tmp = new Vec3();
        this.setGrid(grid);
    }

    /** Rebuild the blocked-region outline for a (re)built grid. */
    setGrid(grid) {
        this.grid = grid;
        // draw on the plane the grid was built against (the estimated real
        // floor); params.source.floorY is the room-AABB floor, which sits
        // visibly below the splat floor
        const y = (grid.floorY ?? this.params.source.floorY) + 0.03;
        const { cols, rows, cell, minX, minZ, blocked } = grid;
        const free = (cx, cz) =>
            cx >= 0 && cz >= 0 && cx < cols && cz < rows && !blocked[cz * cols + cx];
        this._outline = [];
        for (let cz = 0; cz < rows; cz++) {
            for (let cx = 0; cx < cols; cx++) {
                if (!blocked[cz * cols + cx]) continue;
                const x0 = minX + cx * cell;
                const z0 = minZ + cz * cell;
                if (free(cx + 1, cz)) this._outline.push([new Vec3(x0 + cell, y, z0), new Vec3(x0 + cell, y, z0 + cell)]);
                if (free(cx - 1, cz)) this._outline.push([new Vec3(x0, y, z0), new Vec3(x0, y, z0 + cell)]);
                if (free(cx, cz + 1)) this._outline.push([new Vec3(x0, y, z0 + cell), new Vec3(x0 + cell, y, z0 + cell)]);
                if (free(cx, cz - 1)) this._outline.push([new Vec3(x0, y, z0), new Vec3(x0 + cell, y, z0)]);
            }
        }
    }

    update() {
        if (!this.params.source.demo.showNavDebug || this.params.source.mode !== 'demo') return;
        const app = this.app;

        for (const [a, b] of this._outline) app.drawLine(a, b, COL_BLOCKED, false);

        this.wander.states.forEach((s, i) => {
            const col = COL_PATHS[i % COL_PATHS.length];
            let prev = s.pos;
            for (let k = s.waypointIdx; k < s.path.length; k++) {
                app.drawLine(prev, s.path[k], col, false);
                prev = s.path[k];
            }
            if (s.waypointIdx < s.path.length) {
                // goal marker on the last waypoint
                const g = s.path[s.path.length - 1];
                app.drawWireSphere(this._tmp.copy(g), 0.07, col, 8, false);
            }
        });
    }
}
