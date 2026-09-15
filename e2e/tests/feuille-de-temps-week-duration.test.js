const { test } = require('node:test')
const assert = require('node:assert/strict')

test('saisie hebdomadaire : nombres en heures, formats français et durées explicites', async () => {
  const { parseWeekHours } = await import('../../client/src/lib/weekDuration.js')
  for (const [input, expected] of [
    ['40', 2400], [40, 2400], ['37,5', 2250], ['37.5', 2250],
    ['37:30', 2250], ['37h30', 2250], ['40h', 2400], ['90m', 90],
    [' 37,5 ', 2250], ['0,5', 30], ['1,25', 75], ['0', 0], ['', 0],
    ['168', 10080], ['168:00', 10080],
  ]) assert.equal(parseWeekHours(input), expected, String(input))
})

test('saisie hebdomadaire : refus des valeurs invalides ou supérieures à sept jours', async () => {
  const { parseWeekHours } = await import('../../client/src/lib/weekDuration.js')
  for (const input of ['169', '168:01', '168,5', '10081m', '-1', '37:60', 'abc', 'Infinity', '1e3', '3,5,2']) {
    assert.equal(parseWeekHours(input), null, input)
  }
})

test('le champ de pause conserve son interprétation des nombres en minutes', async () => {
  const { parseDurationToMinutes } = await import('../../client/src/lib/duration.js')
  assert.equal(parseDurationToMinutes('40'), 40)
})
