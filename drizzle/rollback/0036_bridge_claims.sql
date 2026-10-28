-- No CASCADE: refuse rollback if an unexpected external dependency exists.
DROP TRIGGER bridge_existing_station_mac ON weather_stations;
DROP FUNCTION bridge_guard_existing_station_mac();
DROP TABLE bridge_forwarding_audit;
DROP TABLE bridge_forwarding_preferences;
DROP TABLE bridge_vendor_credentials;
DROP TABLE bridge_rate_windows;
DROP TABLE bridge_claim_audit;
DROP TABLE bridge_observations;
DROP TABLE bridge_challenges;
DROP TABLE bridge_claims;
