import { readFileSync, writeFileSync } from 'node:fs';

const source = JSON.parse(
  readFileSync(
    'node_modules/three-globe/example/country-polygons/ne_110m_admin_0_countries.geojson',
    'utf8',
  ),
);
const features = source.features.map((item) => ({
  type: 'Feature',
  id: item.properties.ISO_N3,
  properties: { name: item.properties.NAME },
  geometry: item.geometry,
}));
writeFileSync(
  'client/countries-display.json',
  JSON.stringify({ type: 'FeatureCollection', features }),
);
