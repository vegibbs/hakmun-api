-- 235: Add latitude/longitude for weather and map features
ALTER TABLE users ADD COLUMN IF NOT EXISTS location_lat double precision;
ALTER TABLE users ADD COLUMN IF NOT EXISTS location_lon double precision;
