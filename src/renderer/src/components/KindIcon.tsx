import { createElement } from 'react'
import {
  Activity,
  Archive,
  Bell,
  Box,
  Boxes,
  CalendarClock,
  Cloud,
  Copy,
  Cpu,
  Database,
  FileCode2,
  Flame,
  Gauge,
  GitBranch,
  GitMerge,
  Globe,
  HardDrive,
  KeyRound,
  Layers,
  LayoutGrid,
  Lock,
  Network,
  Package,
  Play,
  Puzzle,
  Radar,
  RefreshCw,
  Rocket,
  Route,
  Server,
  ServerCog,
  Shapes,
  ShieldCheck,
  SquareStack,
  Timer,
  Waypoints,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { apiGroupOf, isCustomGroup, type BuiltinKind, type ResourceKind } from '@shared/resources'
import { viewFor, type AddOn, type ViewIconName } from '@renderer/lib/views'

export const KIND_ICONS: Record<BuiltinKind, LucideIcon> = {
  Node: Server,
  Namespace: LayoutGrid,
  Event: Activity,
  Pod: Box,
  Deployment: Layers,
  StatefulSet: Database,
  DaemonSet: Cpu,
  ReplicaSet: Copy,
  Job: Play,
  CronJob: CalendarClock,
  HorizontalPodAutoscaler: Gauge,
  Service: Network,
  Ingress: Globe,
  NetworkPolicy: ShieldCheck,
  ConfigMap: FileCode2,
  Secret: KeyRound,
  PersistentVolumeClaim: HardDrive,
  PersistentVolume: SquareStack,
  StorageClass: Archive,
}

/** The icons views can choose from. */
export const VIEW_ICONS: Record<ViewIconName, LucideIcon> = {
  activity: Activity,
  archive: Archive,
  bell: Bell,
  box: Box,
  boxes: Boxes,
  cloud: Cloud,
  database: Database,
  flame: Flame,
  gauge: Gauge,
  'git-branch': GitBranch,
  'git-merge': GitMerge,
  globe: Globe,
  'key-round': KeyRound,
  layers: Layers,
  lock: Lock,
  network: Network,
  package: Package,
  puzzle: Puzzle,
  radar: Radar,
  'refresh-cw': RefreshCw,
  rocket: Rocket,
  route: Route,
  server: Server,
  'server-cog': ServerCog,
  'shield-check': ShieldCheck,
  timer: Timer,
  waypoints: Waypoints,
  workflow: Workflow,
}

/** A kind's icon: its own, its view's, or one for custom resources or Kubernetes' others. */
export function kindIcon(kind: ResourceKind): LucideIcon {
  const builtin = KIND_ICONS[kind as BuiltinKind]
  if (builtin) return builtin
  const icon = viewFor(kind)?.icon
  if (icon) return VIEW_ICONS[icon]
  return isCustomGroup(apiGroupOf(kind)) ? Puzzle : Shapes
}

/** An add-on's icon: its own, or the one for custom resources. */
export function addOnIcon(addOn: AddOn): LucideIcon {
  return VIEW_ICONS[addOn.icon ?? 'puzzle']
}

/** A kind's icon, as an element. */
export function KindIcon({ kind, className }: { kind: ResourceKind; className?: string }) {
  return createElement(kindIcon(kind), { className, 'aria-hidden': true })
}

/** An add-on's icon, as an element. */
export function AddOnIcon({ addOn, className }: { addOn: AddOn; className?: string }) {
  return createElement(addOnIcon(addOn), { className, 'aria-hidden': true })
}
