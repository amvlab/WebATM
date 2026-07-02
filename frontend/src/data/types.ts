// Core simulation data
export interface SimInfo {
    speed: number;
    simdt: number;
    simt: number;
    simutc: string;
    ntraf: number;
    state: number;
    scenname: string;
    sender_id: string;
}

/**
 * Generic entity data structure
 * Base interface for all moving entities (aircraft, birds, drones, vehicles, etc.)
 */
export interface EntityData {
    id: string[];           // Entity identifiers
    lat: number[];          // Latitudes
    lon: number[];          // Longitudes
    alt: number[];          // Altitudes
    trk: number[];          // Track/heading angles
    vs: number[];           // Vertical speeds
    rpz?: number[];         // Radius of Protected Zone (in meters) - optional, applies to any entity type
}

/**
 * Aircraft-specific data
 * Extends EntityData with aircraft-specific properties
 */
export interface AircraftData extends EntityData {
    tas: number[];          // True Airspeed
    cas?: number[];         // Calibrated Airspeed (optional - may not be sent by backend yet)
    gs?: number[];          // Ground Speed (optional - may not be sent by backend yet)
    actype?: string[];
    inconf: boolean[];      // In conflict status
    tcpamax: number[];      // Time to closest point of approach
    nconf_cur: number;      // Current number of conflicts
    nconf_tot: number;      // Total conflicts detected
    nlos_cur: number;       // Current number of loss of separation events
    nlos_tot: number;       // Total loss of separation events
}

export interface RouteData {
    acid: string;
    iactwp: number;
    aclat: number;
    aclon: number;
    wplat: number[];
    wplon: number[];
    wpalt: number[];
    wpspd: number[];
    wpname: string[];
  }

//   Command and Control Types
export interface CommandResult {
    success: boolean;
    command: string;
  }

  // TODO: standardise with other commands
export interface McreCommand {
    args: string;
    bbox?: number[]
  }
export interface Command {
    command: string;
  }

/**
 * Command dictionary mapping command names to their argument descriptions
 * Example: {'CRE': 'acid,type,lat,lon,hdg,alt,spd', 'HELP': 'cmd,subcmd'}
 */
export interface CommandDict {
  [commandName: string]: string;
}

/**
 * Command dictionary data received from backend via WebSocket
 */
export interface CommandDictData {
  cmddict: CommandDict;
}


//   Network and Connection Types

/**
 * Individual node data structure
 */
export interface NodeData {
  node_num: number;
  status: string;
  time: string;
  server_id_hex?: string;
  server_id_raw?: string;
  server_id?: string;
  [key: string]: unknown;
}

/**
 * Server information
 */
export interface ServerData {
  server_id: string;
  [key: string]: unknown;
}

/**
 * Complete node information from backend
 */
export interface NodeInfo {
  total_nodes: number;
  active_node: string | null;
  nodes: {
    [nodeId: string]: NodeData;
  };
  servers: {
    [serverId: string]: ServerData;
  };
}
export interface ConnectionStatus {
  connected: boolean;
  server: string;
  timestamp: number;
}

/**
 * Detail payload for the `serverStatusUpdate` CustomEvent dispatched on
 * `document`. The event-name-to-payload mapping lives in the
 * DocumentEventMap augmentation in types/globals.d.ts.
 */
export interface ServerStatusUpdateDetail {
  status: ServerStatus;
  message: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  timeout?: number;
}

//   UI and Visualization Types

/**
 * Server data format for polygon shapes (POLY/POLYALT commands)
 * This is how the BlueSky proxy sends polygon data to the client
 */
export interface PolyData {
  name: string;
  lat: number[];
  lon: number[];
  color?: string;
  fill?: boolean;
  top?: number;      // Top altitude in meters (from POLYALT)
  bottom?: number;   // Bottom altitude in meters (from POLYALT)
}

/**
 * Server data format for polyline shapes (POLYLINE commands)
 * This is how the BlueSky proxy sends polyline data to the client
 */
export interface PolylineData {
  name: string;
  lat: number[];
  lon: number[];
  color?: string;
  width?: number;
}

// Client-side shape type system for rendering

/**
 * Shape type enum - extensible for future shape types
 */
export type ShapeType = 'polygon' | 'polyline' | 'circle' | 'rectangle';

/**
 * Base shape interface - all shapes extend this
 */
export interface BaseShape {
  type: ShapeType;
  name: string;
  visible: boolean;
  nodeId?: string;  // Which simulation node this shape belongs to
}

/**
 * Polygon shape - for POLY and POLYALT commands
 * Represents filled areas like zones, regions, restricted areas
 */
export interface PolygonShape extends BaseShape {
  type: 'polygon';
  coordinates: Array<{lat: number, lng: number}>;

  // Altitude constraints (for POLYALT)
  topAltitude?: number;    // Top altitude in feet
  bottomAltitude?: number; // Bottom altitude in feet

  // Styling
  fillColor?: string;
  fillOpacity?: number;
  strokeColor?: string;
  strokeWidth?: number;
  label?: string;
}

/**
 * Polyline shape - for POLYLINE commands
 * Represents paths, routes, boundaries
 */
export interface PolylineShape extends BaseShape {
  type: 'polyline';
  coordinates: Array<{lat: number, lng: number}>;

  // Styling
  color?: string;
  width?: number;
  dashArray?: number[];  // For dashed lines [dash, gap]
  label?: string;
}

/**
 * Circle shape - for future CIRCLE commands
 * Represents circular areas
 */
export interface CircleShape extends BaseShape {
  type: 'circle';
  center: {lat: number, lng: number};
  radius: number;  // In nautical miles or meters
  radiusUnit?: 'nm' | 'm' | 'km';

  // Styling
  fillColor?: string;
  fillOpacity?: number;
  strokeColor?: string;
  strokeWidth?: number;
  label?: string;
}

/**
 * Rectangle shape - for future BOX commands
 * Represents rectangular areas
 */
export interface RectangleShape extends BaseShape {
  type: 'rectangle';
  topLeft: {lat: number, lng: number};
  bottomRight: {lat: number, lng: number};

  // Styling
  fillColor?: string;
  fillOpacity?: number;
  strokeColor?: string;
  strokeWidth?: number;
  label?: string;
}

/**
 * Union type for all shapes
 */
export type Shape = PolygonShape | PolylineShape | CircleShape | RectangleShape;

export interface ShapeDisplayOptions {
  showShapes: boolean;
  showShapeFill: boolean;
  showShapeLines: boolean;
  showShapeLabels: boolean;
}

//   Application State Types

export interface AppState {
  simInfo: SimInfo | null;
  aircraftData: AircraftData | null;
  selectedAircraft: string | null;
  activeNode: string | null;
  shapeOptions: ShapeDisplayOptions;
  serverStatus: ServerStatus;
  displayOptions: DisplayOptions;
  cmddict: CommandDict | null;
  // Per-aircraft 3D model overrides, keyed by aircraft ID.
  // Not persisted across sessions. A missing/empty entry means the
  // aircraft uses the global auto/fixed resolution.
  aircraftModelOverrides: Record<string, string>;
  // Per-aircraft 3D scale overrides, keyed by aircraft ID. Cleared
  // whenever the global aircraft3DScale changes so the new global
  // setting wins.
  aircraftScaleOverrides: Record<string, number>;
}

export interface InitialData {
  siminfo: SimInfo;
  acdata: AircraftData;
  nodes: NodeInfo[];
  poly?: PolyData[];
  polyline?: PolylineData[];
  cmddict?: CommandDict;
  poly_data?: ShapeBatchData<PolyData>;
  polyline_data?: ShapeBatchData<PolylineData>;
}

/**
 * Batched shape payload sent in initial_data: shapes keyed by name.
 */
export interface ShapeBatchData<T extends PolyData | PolylineData = PolyData | PolylineData> {
  polys: { [name: string]: T };
}

/**
 * Echo message payload from the BlueSky server.
 * flags: 0 = info (default), 1 = error, 2 = warning.
 */
export interface EchoData {
  text: string;
  flags?: number;
  sender?: string;
}

// Modal and UI Component Types

export interface ModalOptions {
  id: string;
  title?: string;
  closable?: boolean;
  backdrop?: boolean;
}

export interface ModalState {
  isOpen: boolean;
  element: HTMLElement | null;
}

export type ModalEventType = 'open' | 'close' | 'beforeOpen' | 'beforeClose';

export interface ModalEventHandler {
  (event: ModalEventType, modalId: string): void;
}

// Server Management Types

export type ServerStatus = 'running' | 'stopped' | 'starting' | 'stopping' | 'restarting' | 'unknown' | 'error';

export interface ServerStatusResponse {
  status: ServerStatus;
  message?: string;
  success: boolean;
  timestamp?: number;
}

export interface ServerControlResponse {
  success: boolean;
  message: string;
  status?: ServerStatus;
  error?: string;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  source?: string;
}

export interface ServerLogData {
  status: string;
  logs: {
    combined: string;
  };
  message?: string;
}

export interface LogUpdateData {
  status: string;
  new_content?: string;
  message?: string;
}

/**
 * One line of live server-process log output (integrated build only).
 * `seq` is a monotonic, gap-free sequence number assigned server-side at
 * ingest; the client renders in `seq` order and de-duplicates replays by it.
 */
export interface ServerLogLine {
  seq: number;
  t: number;
  line: string;
}

/**
 * Batch of server log lines pushed over the `server_log` Socket.IO event.
 * `replay` marks a history replay sent to a late-joining client.
 */
export interface ServerLogBatch {
  lines: ServerLogLine[];
  replay?: boolean;
}

// Settings Modal Types

export interface ServerConfigResponse {
  success: boolean;
  server_ip: string;
  message?: string;
  error?: string;
}

export interface MapStyleSettings {
  style: string;
  satelliteEnabled: boolean;
  labelsEnabled: boolean;
}

export interface SettingsModalData {
  serverIp: string;
  mapStyle: MapStyleSettings;
  connectionStatus: boolean;
}

// Panel Layout Storage Types

export interface PanelLayoutState {
  leftPanel: string;
  rightPanel: string;
  consoleContainer: string;
  consoleSection: string;
  echoSection: string;
  trafficPanel: string;
  aircraftPanel: string;
  conflictsPanel: string;
  nodePanel: string;
  navPanel: string;
  displayPanel: string;
  timestamp: number;
  version: string;
}

// Display Options Types

export type SpeedType = 'cas' | 'tas' | 'gs';
export type SpeedUnit = 'm/s' | 'km/h' | 'mph' | 'knots';
export type AltitudeUnit = 'm' | 'km' | 'ft' | 'fl';
export type VerticalSpeedUnit = 'm/s' | 'm/min' | 'ft/min';
export type AircraftShapeType = 'chevron' | 'triangle' | 'aircraft' | 'drone';
// Note: RenderMode is deprecated, kept for backwards compatibility
// Use show3DOverlay instead - 2D is always active, 3D is an optional overlay
export type RenderMode = '2d' | '3d';

export interface DisplayOptions {
  // Text sizes
  headerFontSize: number;   // Header text size (14-32px)
  consoleFontSize: number;  // Console and echo text size (8-20px)
  panelFontSize: number;    // Panel text size (8-20px)

  // Speed display preference
  speedType: SpeedType;

  // Units
  speedUnit: SpeedUnit;
  altitudeUnit: AltitudeUnit;
  verticalSpeedUnit: VerticalSpeedUnit;

  // Collapsible sections state
  sizesVisible: boolean;
  colorsVisible: boolean;
  unitsVisible: boolean;

  // Color customization
  aircraftIconColor: string;
  aircraftLabelColor: string;
  aircraftSelectedColor: string;
  aircraftConflictColor: string;
  aircraftTrailColor: string;
  trailConflictColor: string;
  protectedZonesColor: string;
  routeLabelsColor: string;
  routePointsColor: string;
  routeLinesColor: string;
  shapeFillColor: string;
  shapeLinesColor: string;
  shapeLabelsColor: string;

  // Future map options (stored but not functional yet)
  showAircraft: boolean;
  showAircraftLabels: boolean;
  showAircraftId: boolean;
  showAircraftSpeed: boolean;
  showAircraftAltitude: boolean;
  showAircraftType: boolean;
  showAircraftTrails: boolean;
  showProtectedZones: boolean;
  showRoutes: boolean;
  showRouteLines: boolean;
  showRouteLabels: boolean;
  showRoutePoints: boolean;
  showShapes: boolean;
  showShapeFill: boolean;
  showShapeLines: boolean;
  showShapeLabels: boolean;
  // Navigation data overlay (airports + waypoints from X-Plane navdata,
  // served as vector tiles - see scripts/navdata/)
  showAirports: boolean;
  showAirportIcons: boolean;
  showAirportLabels: boolean;
  showHeliports: boolean;
  showWaypoints: boolean;
  showWaypointIcons: boolean;
  showWaypointLabels: boolean;
  showRunways: boolean;
  showRunwayLabels: boolean;
  showPavement: boolean;
  // Snap drawing/creation clicks to the nearest navaid (airport/heliport/waypoint).
  snapToNavaids: boolean;
  // Show the airport/waypoint "go to" search bar at the top of the map.
  showSearchBar: boolean;
  airportColor: string;
  heliportColor: string;
  waypointColor: string;
  runwayColor: string;
  pavementColor: string;
  aircraftIconSize: number;
  mapLabelsTextSize: number;
  aircraftShape: AircraftShapeType;

  // Rendering mode - deprecated, use show3DOverlay instead
  // Kept for backwards compatibility with stored settings
  renderMode: RenderMode;

  // 3D Overlay toggle. When true, 3D models are rendered as an overlay
  // on top of the 2D view. 2D rendering is always active regardless.
  show3DOverlay: boolean;

  // 3D-specific options (only used when show3DOverlay === true)
  aircraft3DModelQuality?: 'low' | 'medium' | 'high';
  aircraft3DScale: number;
  selectedAircraftModel: string;
  threeDVisible: boolean;
}

/**
 * Aircraft model metadata for 3D model selection
 */
export interface AircraftModelInfo {
  filename: string;     // Model file name (e.g., "737.gltf")
  displayName: string;  // Human-readable name (e.g., "Boeing 737")
  description?: string; // Optional description
  fileSize?: number;    // File size in bytes
  isDefault?: boolean;  // Whether this is the default model
}