import React from 'react';
import { Composition } from 'remotion';
import { Demo, FPS, totalFrames } from './Demo';
export const Root: React.FC = () => (
  <Composition id="Demo" component={Demo} durationInFrames={totalFrames} fps={FPS} width={1920} height={1080} />
);
