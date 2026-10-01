/**
 * @fileoverview Every tool definition this server registers, collected for `createApp()`.
 * @module mcp-server/tools/definitions
 */

import { getArtworks } from './get-artworks.tool.js';
import { lookupVocabulary } from './lookup-vocabulary.tool.js';
import { searchArtists } from './search-artists.tool.js';
import { searchArtworks } from './search-artworks.tool.js';
import { searchAudioGuide } from './search-audio-guide.tool.js';
import { searchExhibitions } from './search-exhibitions.tool.js';

export const allToolDefinitions = [
  searchArtworks,
  getArtworks,
  searchArtists,
  searchExhibitions,
  searchAudioGuide,
  lookupVocabulary,
];
