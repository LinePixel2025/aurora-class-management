/* 预览用声明式渲染器：只复刻宿主 PluginSchemaRenderer 的 DOM 结构与 class，便于用宿主 CSS 检查排版。 */
(function () {
  'use strict'

  function element(tag, className) {
    const node = document.createElement(tag)
    if (className) node.className = className
    return node
  }

  function toneClass(base, tone) {
    return `${base} tone-${tone || 'default'}`
  }

  function childBox(node) {
    const box = element('div', 'plugin-schema')
    if (Array.isArray(node.children)) {
      for (const child of node.children) box.appendChild(renderNode(child))
    }
    return box
  }

  function textNode(tag, className, node, fallback) {
    const elementNode = element(tag, toneClass(className, node.tone))
    elementNode.textContent = typeof node.text === 'string' ? node.text : fallback
    return elementNode
  }

  function renderNode(node) {
    const type = node.type
    if (type === 'stack') {
      const wrapper = element('div', 'node-stack')
      wrapper.appendChild(childBox(node))
      return wrapper
    }
    if (type === 'row') {
      const wrapper = element('div', 'node-row')
      wrapper.appendChild(childBox(node))
      return wrapper
    }
    if (type === 'grid') {
      const wrapper = element('div', 'node-grid')
      const columns = Math.min(4, Math.max(1, node.columnsCount || 2))
      wrapper.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`
      wrapper.appendChild(childBox(node))
      return wrapper
    }
    if (type === 'card') {
      const wrapper = element('section', 'node-card')
      if (node.title) {
        const title = element('h4', 'card-title')
        title.textContent = node.title
        wrapper.appendChild(title)
      }
      wrapper.appendChild(childBox(node))
      return wrapper
    }
    if (type === 'divider') return element('hr', 'node-divider')
    if (type === 'heading') return textNode('h3', 'node-heading', node, '')
    if (type === 'text') return textNode('p', 'node-text', node, '')
    if (type === 'badge') return textNode('span', 'node-badge', node, '')
    if (type === 'progress') {
      const wrapper = element('div', 'node-progress')
      const track = element('div', 'progress-track')
      const fill = element('div', 'progress-fill')
      const percent = Math.min(100, Math.max(0, Number(node.percent) || 0))
      fill.style.width = `${percent}%`
      track.appendChild(fill)
      const label = element('span', 'progress-label tiny')
      label.textContent = `${Math.round(percent)}%`
      wrapper.appendChild(track)
      wrapper.appendChild(label)
      return wrapper
    }
    if (type === 'list') {
      const list = element('ul', 'node-list')
      for (const item of node.items || []) {
        const row = element('li')
        const label = element('span', `tone-${item.tone || 'default'}`)
        label.textContent = typeof item.label === 'string' ? item.label : ''
        row.appendChild(label)
        if (item.value !== undefined) {
          const value = element('span', 'list-value')
          value.textContent = String(item.value)
          row.appendChild(value)
        }
        list.appendChild(row)
      }
      return list
    }
    if (type === 'keyValue') {
      const wrapper = element('div', 'node-kv')
      for (const item of node.items || []) {
        const label = element('span', 'kv-label')
        label.textContent = typeof item.label === 'string' ? item.label : ''
        const value = element('span', `kv-value tone-${item.tone || 'default'}`)
        value.textContent = item.value === undefined ? '' : String(item.value)
        wrapper.appendChild(label)
        wrapper.appendChild(value)
      }
      return wrapper
    }
    if (type === 'table') {
      const wrap = element('div', 'node-table-wrap')
      const table = element('table', 'node-table')
      const thead = document.createElement('thead')
      const row = document.createElement('tr')
      for (const column of node.columns || []) {
        const th = document.createElement('th')
        th.textContent = column.label
        row.appendChild(th)
      }
      thead.appendChild(row)
      table.appendChild(thead)
      const tbody = document.createElement('tbody')
      for (const dataRow of node.rows || []) {
        const tr = document.createElement('tr')
        for (const column of node.columns || []) {
          const td = document.createElement('td')
          td.textContent = typeof dataRow[column.key] === 'string' ? dataRow[column.key] : ''
          tr.appendChild(td)
        }
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      wrap.appendChild(table)
      return wrap
    }
    if (type === 'button') {
      const button = element('button', 'node-button')
      button.type = 'button'
      button.textContent = typeof node.text === 'string' ? node.text : '执行'
      return button
    }
    if (type === 'input') {
      const field = element('label', 'node-field')
      if (node.text) {
        const label = element('span', 'field-label')
        label.textContent = node.text
        field.appendChild(label)
      }
      const input = document.createElement('input')
      input.type = 'text'
      input.placeholder = node.placeholder || ''
      input.value = typeof node.value === 'string' ? node.value : ''
      field.appendChild(input)
      return field
    }
    if (type === 'textarea') {
      const field = element('label', 'node-field')
      if (node.text) {
        const label = element('span', 'field-label')
        label.textContent = node.text
        field.appendChild(label)
      }
      const textarea = document.createElement('textarea')
      textarea.rows = 4
      textarea.placeholder = node.placeholder || ''
      textarea.value = typeof node.value === 'string' ? node.value : ''
      field.appendChild(textarea)
      return field
    }
    if (type === 'select') {
      const field = element('label', 'node-field')
      if (node.text) {
        const label = element('span', 'field-label')
        label.textContent = node.text
        field.appendChild(label)
      }
      const select = document.createElement('select')
      for (const option of node.options || []) {
        const optionNode = document.createElement('option')
        optionNode.value = option.value
        optionNode.textContent = option.label
        if (option.value === node.value) optionNode.selected = true
        select.appendChild(optionNode)
      }
      field.appendChild(select)
      return field
    }
    if (type === 'toggle') {
      const field = element('label', 'node-toggle')
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = node.value === true
      const span = document.createElement('span')
      span.textContent = node.text || ''
      field.appendChild(input)
      field.appendChild(span)
      return field
    }
    if (type === 'number' || type === 'slider') {
      const field = element('label', 'node-field')
      if (node.text) {
        const label = element('span', 'field-label')
        label.textContent = node.text
        field.appendChild(label)
      }
      const input = document.createElement('input')
      input.type = type === 'number' ? 'number' : 'range'
      input.value = node.value === undefined ? (type === 'slider' ? node.min || 0 : '') : node.value
      if (node.min !== undefined) input.min = node.min
      if (node.max !== undefined) input.max = node.max
      if (node.step !== undefined) input.step = node.step
      field.appendChild(input)
      return field
    }
    const unknown = element('div', 'node-text tone-error')
    unknown.textContent = `[未知节点 ${String(type)}]`
    return unknown
  }

  window.PreviewRender = {
    render(container, schema) {
      container.innerHTML = ''
      // 宿主 PluginSchemaRenderer 的根是一个 .plugin-schema（flex 纵向），预览必须一致
      const root = element('div', 'plugin-schema')
      for (const node of schema.nodes || []) root.appendChild(renderNode(node))
      container.appendChild(root)
      return container
    },
  }
})()
