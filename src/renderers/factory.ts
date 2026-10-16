import { Renderer } from '../renderer';
import { Stage } from '../stage/stage';
import { NaiveRenderer } from './naive';
import { ForwardPlusRenderer } from './forward_plus';
import { ClusteredDeferredRenderer, type DeferredVariant } from './clustered_deferred';

export type RenderMode = 'naive' | 'forward+' | 'clustered deferred';

export function createRenderer(mode: RenderMode, stage: Stage, depthPrepass = false, depthClusterCulling = false, deferredVariant: DeferredVariant = 'raster'): Renderer {
    switch (mode) {
        case 'naive': return new NaiveRenderer(stage);
        case 'forward+': return new ForwardPlusRenderer(stage, depthPrepass, depthClusterCulling);
        case 'clustered deferred': return new ClusteredDeferredRenderer(stage, deferredVariant);
    }
}
