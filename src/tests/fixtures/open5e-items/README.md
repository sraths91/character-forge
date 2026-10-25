# Open5e SRD item fixtures

Test data for `src/js/campaign/items.js` / `consumables.js` (M65 R27).
Each file is one Open5e v2 response, fetched 2026-10-25:
`GET https://api.open5e.com/v2/items/<key>/` (armour, shield, weapons)
and the `srd_potion-of-healing` row of
`GET https://api.open5e.com/v2/magicitems/?document__key__in=srd-2014`.
Trimmed: `crossreferences` and the weapon properties' rules prose
(`property.desc`) removed. All are `document.key = "srd-2014"`.

## Attribution

This work includes material taken from the System Reference Document 5.1
("SRD 5.1") by Wizards of the Coast LLC and available at
https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1
is licensed under the Creative Commons Attribution 4.0 International
License available at https://creativecommons.org/licenses/by/4.0/legalcode.

Served via the Open5e API (https://open5e.com).
