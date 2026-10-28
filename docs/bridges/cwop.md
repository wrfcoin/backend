# CWOP/APRS reference ingest

Refs wrfcoin/backend-archive#1496. This absorbs its CWOP scope from
wrfcoin/backend-archive#1495; archived issues remain read-only.

The parser supports the uncompressed positioned weather subset of
[APRS101](https://www.aprs.org/doc/APRS101.PDF): UTC day/hour/minute or receive
 time for untimestamped records, coordinates, temperature, humidity, pressure
and wind. Compressed, positionless, object and status forms are rejected rather
than guessed. Negative Fahrenheit and `h00` (100% humidity) have fixtures.
Fixtures are synthetic recorded protocol examples, not captures from real people.

The read-only client uses the [APRS-IS receive-only login](https://www.aprs-is.net/Connecting.aspx),
limits processing to 100 packets/poll and one poll/minute, and backs off failures.
Only a recorded transport exists. It requires internal caller authentication,
canonicalizes SSIDs to the base callsign, and de-duplicates routing variants.
It never emits a device signature or puts reference observations into the
native signed-submission path. The caller must bind the parsed callsign to the
registry before using its claim ID with the isolated quarantine sink.

Licence-email proof is separate: US fixture mailbox control may verify a
fixture claim; non-US remains reference-only. Neither a weather packet nor an
APRS passcode verifies a claim. Every observation remains unsigned and
non-earning even after fixture mailbox verification.

Consensus follow-up: define a distinct attested bridge provenance type, with
owner ratification and parity gates, before any signed transaction admission.
Do not relabel an operator signature as a native device signature.
