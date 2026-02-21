/**
 * SiloIcon — maps a SiloIconName string to the corresponding lucide-react component.
 *
 * All 16 icons from the curated SILO_ICON_NAMES set are statically imported
 * so Vite can tree-shake everything else from lucide-react.
 */

import {
  FileText,
  Code,
  BookOpen,
  Database,
  Folder,
  Globe,
  Lightbulb,
  Brain,
  Library,
  Beaker,
  GraduationCap,
  Music,
  Camera,
  Pen,
  Archive,
  Briefcase,
} from 'lucide-react';
import type { SiloIconName } from '../../shared/silo-appearance';

type IconComponent = React.ComponentType<{ className?: string }>;

const ICON_MAP: Record<SiloIconName, IconComponent> = {
  'file-text': FileText,
  'code': Code,
  'book-open': BookOpen,
  'database': Database,
  'folder': Folder,
  'globe': Globe,
  'lightbulb': Lightbulb,
  'brain': Brain,
  'library': Library,
  'beaker': Beaker,
  'graduation-cap': GraduationCap,
  'music': Music,
  'camera': Camera,
  'pen': Pen,
  'archive': Archive,
  'briefcase': Briefcase,
};

interface SiloIconProps {
  icon: SiloIconName;
  className?: string;
}

export default function SiloIcon({ icon, className }: SiloIconProps) {
  const Icon = ICON_MAP[icon] ?? Database;
  return <Icon className={className} />;
}
