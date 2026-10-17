# Open5e SRD creature fixtures

Test data for `src/js/scene/open5e-normalize.js` (M64 R11). Each file is
one `GET https://api.open5e.com/v2/creatures/<key>/` response, fetched
2026-10-16 and trimmed to the fields the normaliser reads (languages,
environments, illustration, cross-references and the like removed). All
are `document.key = "srd-2014"`: the 20 creatures named in the R11 task
plus `srd_adult-red-dragon` for legendary-action coverage.

The structured `actions[].attacks[]` fields are kept as Open5e serves
them, including their errors (every damage type reads `thunder`, the
damage bonus is `null`): the normaliser parses the `desc` text and uses
those fields only as a cross-check, and the tests depend on the errors
being present.

## Attribution

This work includes material taken from the System Reference Document 5.1
("SRD 5.1") by Wizards of the Coast LLC and available at
https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1
is licensed under the Creative Commons Attribution 4.0 International
License available at https://creativecommons.org/licenses/by/4.0/legalcode.

Served via the Open5e API (https://open5e.com).
