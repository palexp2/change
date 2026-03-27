import MetricBlock from './blocks/MetricBlock.jsx'
import ChartBlock from './blocks/ChartBlock.jsx'
import ListBlock from './blocks/ListBlock.jsx'
import DetailBlock from './blocks/DetailBlock.jsx'
import FormBlock from './blocks/FormBlock.jsx'
import ButtonBlock from './blocks/ButtonBlock.jsx'
import TextBlock from './blocks/TextBlock.jsx'
import FilterBlock from './blocks/FilterBlock.jsx'
import InteractionTimelineBlock from './blocks/InteractionTimelineBlock.jsx'

const BLOCK_COMPONENTS = {
  metric:                MetricBlock,
  chart:                 ChartBlock,
  list:                  ListBlock,
  detail:                DetailBlock,
  form:                  FormBlock,
  button:                ButtonBlock,
  text:                  TextBlock,
  filter:                FilterBlock,
  interaction_timeline:  InteractionTimelineBlock,
}

export default function BlockRenderer({
  block,
  filterValues,
  selectedRecord,
  onRecordSelect,
  onFilterChange,
  onRecordChange,
}) {
  const config = (() => {
    try { return typeof block.config === 'string' ? JSON.parse(block.config) : (block.config || {}) }
    catch { return {} }
  })()

  const Component = BLOCK_COMPONENTS[block.type]
  if (!Component) {
    return <div className="text-xs text-gray-400 italic p-2">Type inconnu : {block.type}</div>
  }

  return (
    <Component
      block={block}
      config={config}
      filterValues={filterValues}
      selectedRecord={selectedRecord}
      selectedRecordId={selectedRecord?.id}
      onRecordSelect={onRecordSelect}
      onFilterChange={(value) => onFilterChange?.(block.id, value)}
      onRecordChange={onRecordChange}
    />
  )
}
