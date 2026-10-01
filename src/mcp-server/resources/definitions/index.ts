/**
 * @fileoverview Every resource definition this server registers, collected for `createApp()`.
 * @module mcp-server/resources/definitions
 */

import { artworkResource } from './artwork.resource.js';

export const allResourceDefinitions = [artworkResource];
