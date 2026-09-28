import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutionJob } from '@qa-nxt/shared-types';
import type { ControlPlaneClient } from '../api/control-plane-client.js';
import type { BaselineStore } from './visual-runner.js';

/**
 * A baseline store backed by the control plane.
 *
 * Baselines outlive a run, so they cannot live beside the run's evidence — a comparison
 * needs the appearance somebody agreed to weeks ago. The three images a reviewer looks at
 * on a difference are ordinary artifacts and are uploaded as such; only the agreed
 * appearance is kept separately, by the platform, keyed by test, name, browser and
 * viewport.
 */
export function createBaselineStore(client: ControlPlaneClient, job: ExecutionJob): BaselineStore {
  return {
    async load({ name, viewport }) {
      return client.visualBaseline(job.executionId, {
        name, browser: job.browser, width: viewport.width, height: viewport.height
      });
    },

    async save({ name, viewport }, png) {
      const { width, height } = readPngSize(png);
      return client.putVisualBaseline(job.executionId, {
        name, browser: job.browser,
        width: viewport.width, height: viewport.height,
        imageWidth: width, imageHeight: height
      }, png);
    },

    async attach(name, kind, png) {
      // Written to disk and uploaded through the ordinary artifact path, so a diff image
      // is browsable and downloadable exactly like a screenshot.
      const directory = await mkdtemp(join(tmpdir(), 'qanxt-visual-'));
      const file = join(directory, `${sanitise(name)}-${kind}.png`);
      await writeFile(file, png);
      return client.uploadArtifact(file, `visual-${sanitise(name)}-${kind}.png`, 'image/png');
    }
  };
}

/** Width and height from a PNG's IHDR chunk, which is always the first 24 bytes. */
function readPngSize(png: Buffer): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const sanitise = (name: string): string =>
  name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'baseline';
