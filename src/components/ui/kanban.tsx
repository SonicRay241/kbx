import * as React from 'react'
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type {
  DragCancelEvent,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  DropAnimation,
  Modifiers,
  UniqueIdentifier,
  DraggableAttributes,
  DraggableSyntheticListeners
} from '@dnd-kit/core'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  defaultDropAnimationSideEffects
} from '@dnd-kit/core'
import {
  arrayMove,
  defaultAnimateLayoutChanges,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  type AnimateLayoutChanges
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Slot } from 'radix-ui'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'

// Stable module-level constants — never recreated, won't trigger dnd-kit effects
const measuringConfig = {
  droppable: { strategy: MeasuringStrategy.BeforeDragging }
}

const pointerActivationConstraint = { distance: 10 }

interface KanbanContextProps<T> {
  columns: Record<string, T[]>
  setColumns: (columns: Record<string, T[]>) => void
  getItemId: (item: T) => string
  columnIds: string[]
  activeId: UniqueIdentifier | null
  setActiveId: (id: UniqueIdentifier | null) => void
  findContainer: (id: UniqueIdentifier) => string | undefined
  isColumn: (id: UniqueIdentifier) => boolean
  modifiers?: Modifiers
}

const KanbanContext = createContext<KanbanContextProps<any>>({
  columns: {},
  setColumns: () => {},
  getItemId: () => '',
  columnIds: [],
  activeId: null,
  setActiveId: () => {},
  findContainer: () => undefined,
  isColumn: () => false,
  modifiers: undefined
})

const ColumnContext = createContext<{
  attributes: DraggableAttributes
  listeners: DraggableSyntheticListeners | undefined
  isDragging?: boolean
  disabled?: boolean | KanbanDisable
}>({
  attributes: {} as DraggableAttributes,
  listeners: undefined,
  isDragging: false,
  disabled: false
})

const ItemContext = createContext<{
  listeners: DraggableSyntheticListeners | undefined
  isDragging?: boolean
  disabled?: boolean | KanbanDisable
}>({
  listeners: undefined,
  isDragging: false,
  disabled: false
})

const IsOverlayContext = createContext(false)

/**
 * Drag-veto state, event-driven. `vetoed`: the hovered container would refuse the drop.
 * `draggedCardId`: numeric id of the currently dragged card (null when none / a column is dragged).
 */
const VetoContext = createContext<{ vetoed: boolean; draggedCardId: number | null }>({ vetoed: false, draggedCardId: null })

const animateLayoutChanges: AnimateLayoutChanges = args => defaultAnimateLayoutChanges({ ...args, wasDragging: true })

const dropAnimationConfig: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: {
        opacity: '0.4'
      }
    }
  })
}

export interface KanbanMoveEvent {
  event: DragEndEvent | DragOverEvent
  /** false = live drag-over preview (same-column reorders during hover); true = drop-time move. */
  commit: boolean
  activeContainer: string
  activeIndex: number
  overContainer: string
  overIndex: number
}

// Structural mirror of @dnd-kit/sortable's internal `Disabled` ({draggable, droppable}):
// not re-exported from its public index.d.ts, so declared here.
export type KanbanDisable = { draggable?: boolean; droppable?: boolean }

export interface KanbanRootProps<T> extends HTMLAttributes<HTMLDivElement> {
  value: Record<string, T[]>
  onValueChange: (value: Record<string, T[]>) => void
  getItemValue: (item: T) => string
  children: ReactNode
  onMove?: (event: KanbanMoveEvent) => void
  /** Fires once per drag when it begins (before any move) — distinct from native onDragStart. */
  onDragBegin?: (event: DragStartEvent) => void
  onDragCancel?: (event: DragCancelEvent) => void
  /**
   * Decides drop-refusal for the veto highlight: return true for (active id, container id)
   * pairs whose drop must be refused. Purely visual — actual refusal stays in onMove.
   */
  isDropVetoed?: (activeId: number, containerId: string) => boolean
  /** Registers the consumer's optimistic-layout ref via a setter callback; the primitive reads it during drags instead of the (possibly stale) rendered value. */
  registerDragLayout?: (adopt: (ref: React.MutableRefObject<Record<string, T[]> | null>) => void) => void
  asChild?: boolean
  modifiers?: Modifiers
}

function Kanban<T>({
  value,
  onValueChange,
  getItemValue,
  children,
  className,
  asChild = false,
  onMove,
  onDragBegin,
  onDragCancel,
  isDropVetoed,
  registerDragLayout,
  modifiers,
  ...props
}: KanbanRootProps<T>) {
  const columns = value
  const setColumns = onValueChange
  const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null)

  // Consumer-published optimistic layout (null when no consumer registered one).
  // While dragging, columnsRef points at it so dnd-kit's preview/commit index math sees
  // the composed mirror, not the possibly-stale rendered value (render can lag a frame
  // behind RAF bursts → previews applied twice → ghost duplicate of the dragged card).
  const dragLayoutExternalRef = useRef<React.MutableRefObject<Record<string, unknown[]> | null> | null>(null)

  // Refs so all callbacks read the latest values without being recreated on every render.
  // This breaks the cascade: columns change → callbacks recreate → DndContext re-registers → loop.
  const columnsRef = useRef(columns)

  columnsRef.current = columns

  // While dragging, dnd-kit's indices must reflect the mirror, not the possibly-stale render.
  if (activeId !== null) columnsRef.current = (dragLayoutExternalRef.current?.current ?? columns) as Record<string, T[]>

  const getItemValueRef = useRef(getItemValue)

  getItemValueRef.current = getItemValue

  const onMoveRef = useRef(onMove)

  onMoveRef.current = onMove

  const onDragBeginRef = useRef(onDragBegin)

  onDragBeginRef.current = onDragBegin

  const onDragCancelRef = useRef(onDragCancel)

  onDragCancelRef.current = onDragCancel

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: pointerActivationConstraint }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const columnIds = useMemo(() => Object.keys(columns), [columns])

  const isColumn = useCallback((id: UniqueIdentifier) => columnIds.includes(id as string), [columnIds])

  // findContainer reads columnsRef so it doesn't need columns or getItemValue in its deps.
  const findContainer = useCallback(
    (id: UniqueIdentifier) => {
      if (isColumn(id)) return id as string
      const cols = columnsRef.current
      const getId = getItemValueRef.current

      return Object.keys(cols).find(key => cols[key].some(item => getId(item) === id))
    },
    [isColumn]
  )

  // Live drag state for the veto highlight. We can't read the DndContext from this
  // component (it renders BELOW the provider here), so track the hovered container
  // from drag events directly. Cleared on drag end/cancel.
  const [vetoOverContainer, setVetoOverContainer] = useState<string | null>(null)
  const vetoedContainerId = useMemo(() => {
    if (!isDropVetoed || !activeId || vetoOverContainer === null) return null
    const activeIdNum = Number(activeId)
    if (Number.isNaN(activeIdNum) || isColumn(activeId)) return null
    return isDropVetoed(activeIdNum, vetoOverContainer) ? vetoOverContainer : null
  }, [isDropVetoed, activeId, vetoOverContainer, isColumn])

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      onDragBeginRef.current?.(event)
      setVetoOverContainer(null)
      setActiveId(event.active.id)
    },
    []
  )

  // RAF refs throttle onDragOver: we only process the latest event per animation frame.
  // This prevents React from receiving dozens of setState calls per frame during rapid drags,
  // which is what causes "Maximum update depth exceeded".
  const dragOverRafRef = useRef<number | null>(null)
  const pendingDragOverRef = useRef<DragOverEvent | null>(null)

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      // When a persisted-mode consumer supplies onMove, still shuffle previews within the
      // current column during drag; cross-column moves stay deferred to onDragEnd (iframe
      // pointer-capture loss — an item changing column unmounts its DOM node mid-drag).
      // The pending in-flight move is passed along so consumers can veto or preview it.
      pendingDragOverRef.current = event
      if (dragOverRafRef.current !== null) return

      dragOverRafRef.current = requestAnimationFrame(() => {
        dragOverRafRef.current = null
        const latestEvent = pendingDragOverRef.current

        pendingDragOverRef.current = null
        if (!latestEvent) return

        const { active, over } = latestEvent

        if (!over) {
          setVetoOverContainer(null)
          return
        }
        if (isColumn(active.id)) return

        const overContainer = findContainer(over.id)
        // Track the hovered container for the veto highlight (cheap, event-driven).
        setVetoOverContainer(overContainer ?? null)
        if (!overContainer) return

        const activeContainer = findContainer(active.id)

        // Only reorder within the same column during drag. Cross-column moves are
        // committed in onDragEnd instead — moving an item to another column unmounts
        // its DOM node and remounts it, which releases pointer capture and causes the
        // drag to end prematurely when the kanban is rendered inside an iframe.
        if (activeContainer !== overContainer) return

        const cols = columnsRef.current
        const getId = getItemValueRef.current
        const activeIndex = cols[activeContainer].findIndex((item: T) => getId(item) === active.id)
        // Hovering the column body itself (not an item) → insert at the end.
        const overIndex = isColumn(over.id) ? cols[overContainer].length : cols[overContainer].findIndex((item: T) => getId(item) === over.id)

        if (activeIndex === overIndex) return

        if (onMoveRef.current) {
          // Persisted mode: report the pending reorder instead of committing it —
          // the consumer mirrors it optimistically and persists on drop.
          onMoveRef.current({
            event: latestEvent,
            commit: false,
            activeContainer,
            activeIndex,
            overContainer,
            overIndex
          })
          return
        }

        setColumns({
          ...cols,
          [activeContainer]: arrayMove(cols[activeContainer], activeIndex, overIndex)
        })
      })
    },
    [findContainer, isColumn, setColumns]
  )

  const flushPendingDragOver = useCallback(() => {
    if (dragOverRafRef.current !== null) {
      cancelAnimationFrame(dragOverRafRef.current)
      dragOverRafRef.current = null
    }

    pendingDragOverRef.current = null
  }, [])

  const handleDragCancel = useCallback(
    (event: DragCancelEvent) => {
      flushPendingDragOver()
      setVetoOverContainer(null)
      setActiveId(null)
      onDragCancelRef.current?.(event)
    },
    [flushPendingDragOver]
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      flushPendingDragOver()

      const { active, over } = event

      setVetoOverContainer(null)
      setActiveId(null)

      if (!over) return

      if (onMoveRef.current && !isColumn(active.id)) {
        const cols = columnsRef.current
        const getId = getItemValueRef.current
        const activeContainer = findContainer(active.id)
        const overContainer = findContainer(over.id)

        if (activeContainer && overContainer) {
          const activeIndex = cols[activeContainer].findIndex((item: T) => getId(item) === active.id)

          const overIndex = isColumn(over.id)
            ? cols[overContainer].length
            : cols[overContainer].findIndex((item: T) => getId(item) === over.id)

          onMoveRef.current({ event, commit: true, activeContainer, activeIndex, overContainer, overIndex })
        }

        return
      }

      if (isColumn(active.id) && isColumn(over.id)) {
        const cols = columnsRef.current
        const keys = Object.keys(cols)
        const activeIndex = keys.indexOf(active.id as string)
        const overIndex = keys.indexOf(over.id as string)

        if (activeIndex !== overIndex) {
          const newOrder = arrayMove(keys, activeIndex, overIndex)
          const newColumns: Record<string, T[]> = {}

          newOrder.forEach(key => {
            newColumns[key] = cols[key]
          })

          setColumns(newColumns)
        }

        return
      }

      const activeContainer = findContainer(active.id)
      const overContainer = findContainer(over.id)

      if (!activeContainer || !overContainer) return

      const cols = columnsRef.current
      const getId = getItemValueRef.current
      const activeIndex = cols[activeContainer].findIndex((item: T) => getId(item) === active.id)

      if (activeContainer === overContainer) {
        const overIndex = cols[overContainer].findIndex((item: T) => getId(item) === over.id)

        if (activeIndex !== overIndex) {
          setColumns({
            ...cols,
            [activeContainer]: arrayMove(cols[activeContainer], activeIndex, overIndex)
          })
        }

        return
      }

      // Cross-column move: committed on drop to prevent DOM element recreation
      // during drag which causes pointer capture loss in iframe contexts
      const overItems = cols[overContainer]

      const overIndex = isColumn(over.id) ? overItems.length : overItems.findIndex((item: T) => getId(item) === over.id)

      const newActiveItems = [...cols[activeContainer]]
      const newOverItems = [...overItems]
      const [movedItem] = newActiveItems.splice(activeIndex, 1)

      newOverItems.splice(overIndex, 0, movedItem)

      setColumns({
        ...cols,
        [activeContainer]: newActiveItems,
        [overContainer]: newOverItems
      })
    },
    [findContainer, isColumn, setColumns, flushPendingDragOver]
  )

  const registerDragLayoutStable = useRef(registerDragLayout)
  registerDragLayoutStable.current = registerDragLayout

  useEffect(() => {
    const register = registerDragLayoutStable.current
    if (!register) return
    // Board publishes its optimistic layout ref; the primitive adopts it for index math.
    let adopted: React.MutableRefObject<Record<string, unknown[]> | null> | null = null
    register(ref => {
      adopted = ref as React.MutableRefObject<Record<string, unknown[]> | null>
    })
    dragLayoutExternalRef.current = adopted
    return () => { dragLayoutExternalRef.current = null }
  }, [])

  const stableGetItemId = useCallback((item: T) => getItemValueRef.current(item), [])

  const contextValue = useMemo(
    () => ({
      columns,
      setColumns,
      getItemId: stableGetItemId,
      columnIds,
      activeId,
      setActiveId,
      findContainer,
      isColumn,
      modifiers
    }),
    [columns, setColumns, stableGetItemId, columnIds, activeId, findContainer, isColumn, modifiers]
  )

  // Board publishes { vetoed, draggedCardId } through VetoContext; the optimistic
  // layout ref is adopted directly into columnsRef via registerDragLayout.
  const Comp = asChild ? Slot.Root : 'div'

  return (
    <KanbanContext.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        modifiers={modifiers}
        measuring={measuringConfig}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <Comp
          data-slot='kanban'
          data-dragging={activeId !== null}
          className={cn(activeId !== null && 'cursor-grabbing!', className)}
          {...props}
        >
          <VetoContext.Provider
            value={{
              vetoed: vetoedContainerId != null,
              draggedCardId: activeId && !isColumn(activeId) ? Number(activeId) : null
            }}
          >
            {children}
          </VetoContext.Provider>
        </Comp>
      </DndContext>
    </KanbanContext.Provider>
  )
}

export interface KanbanBoardProps extends HTMLAttributes<HTMLDivElement> {
  asChild?: boolean
}

function KanbanBoard({ className, asChild = false, children, ...props }: KanbanBoardProps) {
  const { columnIds } = useContext(KanbanContext)
  const Comp = asChild ? Slot.Root : 'div'

  return (
    <SortableContext items={columnIds} strategy={rectSortingStrategy}>
      <Comp data-slot='kanban-board' className={cn('grid auto-rows-fr gap-4 sm:grid-cols-3', className)} {...props}>
        {children}
      </Comp>
    </SortableContext>
  )
}

export interface KanbanColumnProps extends HTMLAttributes<HTMLDivElement> {
  value: string
  disabled?: boolean | KanbanDisable
  asChild?: boolean
}

function KanbanColumn({ value, className, asChild = false, disabled, children, ...props }: KanbanColumnProps) {
  const isOverlay = useContext(IsOverlayContext)
  const disableAll = disabled === true

  const {
    setNodeRef,
    transform,
    transition,
    attributes,
    listeners,
    isDragging: isSortableDragging
  } = useSortable({
    id: value,
    disabled: disableAll || (isOverlay ? true : disabled),
    animateLayoutChanges
  })

  const { activeId, isColumn } = useContext(KanbanContext)
  const isColumnDragging = activeId ? isColumn(activeId) : false

  const style = {
    transition,
    transform: CSS.Transform.toString(transform)
  } as CSSProperties

  const Comp = asChild ? Slot.Root : 'div'

  if (isOverlay) {
    return (
      <ColumnContext.Provider
        value={{
          attributes: {} as DraggableAttributes,
          listeners: undefined,
          isDragging: true,
          disabled: false
        }}
      >
        <Comp
          data-slot='kanban-column'
          data-value={value}
          data-dragging={true}
          className={cn('group/kanban-column flex flex-col', className)}
          {...props}
        >
          {children}
        </Comp>
      </ColumnContext.Provider>
    )
  }

  return (
    <ColumnContext.Provider value={{ attributes, listeners, isDragging: isColumnDragging, disabled }}>
      <Comp
        data-slot='kanban-column'
        data-value={value}
        data-dragging={isSortableDragging}
        data-disabled={disabled}
        ref={setNodeRef}
        style={style}
        className={cn(
          'group/kanban-column flex flex-col',
          isSortableDragging && 'z-50 opacity-50',
          disableAll && 'opacity-50',
          className
        )}
        {...props}
      >
        {children}
      </Comp>
    </ColumnContext.Provider>
  )
}

export interface KanbanColumnHandleProps extends HTMLAttributes<HTMLDivElement> {
  cursor?: boolean
  asChild?: boolean
}

function KanbanColumnHandle({
  className,
  asChild = false,
  cursor = true,
  children,
  ...props
}: KanbanColumnHandleProps) {
  const { attributes, listeners, isDragging, disabled } = useContext(ColumnContext)

  const Comp = asChild ? Slot.Root : 'div'

  return (
    <Comp
      data-slot='kanban-column-handle'
      data-dragging={isDragging}
      data-disabled={disabled}
      suppressHydrationWarning
      {...attributes}
      {...listeners}
      className={cn(
        'opacity-0 transition-opacity group-hover/kanban-column:opacity-100',
        cursor && (isDragging ? 'cursor-grabbing!' : 'cursor-grab!'),
        className
      )}
      {...props}
    >
      {children}
    </Comp>
  )
}

export interface KanbanItemProps extends HTMLAttributes<HTMLDivElement> {
  value: string
  /** Boolean `true` disables both drag and drop; object form disables per-axis ({draggable: true} = undraggable but still a drop target). */
  disabled?: boolean | KanbanDisable
  asChild?: boolean
}

function KanbanItem({ value, className, asChild = false, disabled, children, ...props }: KanbanItemProps) {
  const isOverlay = useContext(IsOverlayContext)
  const disableAll = disabled === true

  const {
    setNodeRef,
    transform,
    transition,
    attributes,
    listeners,
    isDragging: isSortableDragging
  } = useSortable({
    id: value,
    disabled: disableAll || (isOverlay ? true : disabled),
    animateLayoutChanges
  })

  const { activeId, isColumn } = useContext(KanbanContext)
  const isItemDragging = activeId ? !isColumn(activeId) : false

  const style = {
    transition,
    transform: CSS.Transform.toString(transform)
  } as CSSProperties

  const Comp = asChild ? Slot.Root : 'div'

  if (isOverlay) {
    return (
      <ItemContext.Provider value={{ listeners: undefined, isDragging: true, disabled: false }}>
        <Comp data-slot='kanban-item' data-value={value} data-dragging={true} className={cn(className)} {...props}>
          {children}
        </Comp>
      </ItemContext.Provider>
    )
  }

  return (
    <ItemContext.Provider value={{ listeners, isDragging: isItemDragging, disabled }}>
      <Comp
        data-slot='kanban-item'
        data-value={value}
        data-dragging={isSortableDragging}
        data-disabled={disabled}
        suppressHydrationWarning
        ref={setNodeRef}
        style={style}
        {...attributes}
        className={cn(isSortableDragging && 'z-50 opacity-50', disableAll && 'opacity-50', className)}
        {...props}
      >
        {children}
      </Comp>
    </ItemContext.Provider>
  )
}

export interface KanbanItemHandleProps extends HTMLAttributes<HTMLDivElement> {
  cursor?: boolean
  asChild?: boolean
}

function KanbanItemHandle({ className, asChild = false, cursor = true, children, ...props }: KanbanItemHandleProps) {
  const { listeners, isDragging, disabled } = useContext(ItemContext)

  const Comp = asChild ? Slot.Root : 'div'

  return (
    <Comp
      data-slot='kanban-item-handle'
      data-dragging={isDragging}
      data-disabled={disabled}
      {...listeners}
      className={cn(cursor && (isDragging ? 'cursor-grabbing!' : 'cursor-grab!'), className)}
      {...props}
    >
      {children}
    </Comp>
  )
}

export interface KanbanColumnContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string
  asChild?: boolean
}

function KanbanColumnContent({ value, className, asChild = false, children, ...props }: KanbanColumnContentProps) {
  const { columns, getItemId } = useContext(KanbanContext)

  const itemIds = useMemo(() => columns[value].map(getItemId), [columns, getItemId, value])

  const Comp = asChild ? Slot.Root : 'div'

  return (
    <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
      <Comp data-slot='kanban-column-content' className={cn('flex flex-col gap-2', className)} {...props}>
        {children}
      </Comp>
    </SortableContext>
  )
}

export interface KanbanOverlayProps extends Omit<React.ComponentProps<typeof DragOverlay>, 'children'> {
  children?: ReactNode | ((params: { value: UniqueIdentifier; variant: 'column' | 'item' }) => ReactNode)
}

function KanbanOverlay({ children, className, ...props }: KanbanOverlayProps) {
  const { activeId, isColumn, modifiers } = useContext(KanbanContext)
  const [mounted, setMounted] = useState(false)

  useLayoutEffect(() => setMounted(true), [])

  const variant = activeId ? (isColumn(activeId) ? 'column' : 'item') : 'item'

  const content =
    activeId && children ? (typeof children === 'function' ? children({ value: activeId, variant }) : children) : null

  if (!mounted) return null

  return createPortal(
    <DragOverlay
      dropAnimation={dropAnimationConfig}
      modifiers={modifiers}
      className={cn('z-50', activeId && 'cursor-grabbing', className)}
      {...props}
    >
      <IsOverlayContext.Provider value={true}>{content}</IsOverlayContext.Provider>
    </DragOverlay>,
    document.body
  )
}

export {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnHandle,
  KanbanItem,
  KanbanItemHandle,
  KanbanColumnContent,
  KanbanOverlay
}

/** True while the hovered (active, container) pair would be refused at drop; read via useContext in column components. */
export { VetoContext }
