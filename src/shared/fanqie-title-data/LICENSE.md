# CVDICT title lookup data

These JSON files are an adapted subset of CVDICT by **Phong Phan**:
https://github.com/ph0ngp/CVDICT
Source revision: c379d909e308343a247e51619f7839a2060a271c.
Original data: https://github.com/ph0ngp/CVDICT/blob/c379d909e308343a247e51619f7839a2060a271c/CVDICT.u8

CVDICT is based on CC-CEDICT (https://www.mdbg.net/chinese/dictionary?page=cc-cedict), originally CEDICT, Copyright (C) 1997, 1998 Paul Andrew Denisowski.

This adapted **dictionary data** is licensed under Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0):
https://creativecommons.org/licenses/by-sa/4.0/

Changes: retain Chinese keys and the first short Vietnamese definition; remove pronunciation and explanatory annotations; include simplified and traditional keys; split into bounded runtime files. Reproduce with tools/build-title-lexicon.py and the source file above. The author notes possible translation and proper-name errors. This is dictionary data, not a collection of novels or reader information. Attribution and this license must accompany redistributed adaptations.

## Display-font character maps

font-library.json, font-search.json and font-home.json are character correspondences derived by
matching the rendered Fanqie fonts e26e946d8b2ccb7 / c207f68a84deae3 / dc027189e0ba4cd against Adobe
Source Han Sans SC Normal 2.002R. Each map matches 362 glyphs. No font binaries are
redistributed. Only use a map with its exact font identifier; unknown fonts are
left unchanged. Reproduction tool: tools/build-fanqie-font-map.py.

Reference font: https://github.com/adobe-fonts/source-han-sans/tree/2.002R
Adobe Source Han Sans is licensed under SIL Open Font License 1.1:
https://github.com/adobe-fonts/source-han-sans/blob/2.002R/LICENSE.txt
