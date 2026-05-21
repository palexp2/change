// Colonnes dérivées "permissions des contrôleurs centraux" agrégées par
// company_id. Restreint aux CC dont le status est "Opérationnel - Vendu"
// ou "Opérationnel - Loué" (les autres CC ne reflètent pas une installation
// active facturable). Agrégation SUM : si une entreprise a plusieurs CC,
// la capacité totale autorisée est la somme.

// Clé JSON dans permissions  →  alias SQL exposé côté API
export const CC_PERMISSION_FIELDS = [
  ['maxNumberOfCirculationFans',                       'company_max_circulation_fans'],
  ['maxNumberOfFans',                                  'company_max_fans'],
  ['maxNumberOfVentilationFans',                       'company_max_ventilation_fans'],
  ['maxNumberOfHeaters',                               'company_max_heaters'],
  ['maxNumberOfHeatPipes',                             'company_max_heat_pipes'],
  ['maxNumberOfMisters',                               'company_max_misters'],
  ['maxNumberOfRoofs',                                 'company_max_roofs'],
  ['maxNumberOfTensiometers',                          'company_max_tensiometers'],
  ['maxNumberOfThermalScreens',                        'company_max_thermal_screens'],
  ['maxNumberOfValves',                                'company_max_valves'],
  ['maxNumberOfGreenhousesWithAdvancedVentilation',    'company_max_gh_advanced_ventilation'],
  ['maxNumberOfGreenhousesWithDiseasePrevention',      'company_max_gh_disease_prevention'],
  ['maxNumberOfGreenhousesWithHeating',                'company_max_gh_heating'],
  ['maxNumberOfGreenhousesWithHumidityConservation',   'company_max_gh_humidity_conservation'],
  ['maxNumberOfGreenhousesWithIrrigation',             'company_max_gh_irrigation'],
  ['maxNumberOfGreenhousesWithRollupVentilation',      'company_max_gh_rollup_ventilation'],
]

// SELECT clauses à injecter au niveau top (avec préfixe ccp.)
// Inclut un flag `company_has_cc_permissions` qui vaut 1 si l'entreprise a
// au moins un CC Opérationnel - Vendu/Loué avec permissions importées,
// sinon NULL (= info manquante). Utile pour filtrer "info inconnue".
export const CC_PERMISSION_SELECT = [
  'ccp.company_has_cc_permissions',
  ...CC_PERMISSION_FIELDS.map(([, alias]) => `ccp.${alias}`),
].join(',\n        ')

// Sous-requête agrégée : un row par company_id avec la SUM de chaque clé
// JSON convertie en INTEGER. Les chaînes vides ou non-numériques tombent
// à 0 grâce au CAST(...) qui retourne 0 pour les non-parsables en SQLite.
export const CC_PERMISSIONS_JOIN = `
  LEFT JOIN (
    SELECT
      sn.company_id,
      1 AS company_has_cc_permissions,
      ${CC_PERMISSION_FIELDS.map(([jsonKey, alias]) =>
        `SUM(COALESCE(CAST(json_extract(sn.permissions, '$.${jsonKey}') AS INTEGER), 0)) AS ${alias}`
      ).join(',\n      ')}
    FROM serial_numbers sn
    LEFT JOIN products pr ON pr.id = sn.product_id
    WHERE sn.permissions IS NOT NULL
      AND pr.name_fr LIKE 'Contrôleur central%'
      AND sn.status IN ('Opérationnel - Vendu', 'Opérationnel - Loué')
    GROUP BY sn.company_id
  ) ccp
`
