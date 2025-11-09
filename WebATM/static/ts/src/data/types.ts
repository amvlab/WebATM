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
  [key: string]: any;
}

/**
 * Server information
 */
export interface ServerData {
  server_id: string;
  [key: string]: any;
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
  connected: boolean;
  blueSkyConnected: boolean;
  receivingData: boolean;
  simInfo: SimInfo | null;
  aircraftData: AircraftData | null;
  selectedAircraft: string | null;
  activeNode: string | null;
  shapeOptions: ShapeDisplayOptions;
  serverStatus: ServerStatus;
  displayOptions: DisplayOptions;
  cmddict: CommandDict | null;
}

export interface InitialData {
  siminfo: SimInfo;
  acdata: AircraftData;
  nodes: NodeInfo[];
  poly?: PolyData[];
  polyline?: PolylineData[];
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
  aircraftIconSize: number;
  mapLabelsTextSize: number;
  aircraftShape: AircraftShapeType;
}