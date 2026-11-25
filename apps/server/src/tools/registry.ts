import type { ToolName } from '@kept/mcp';
import { adjustStockTool } from './handlers/consumables.js';
import {
  addWarranty,
  borrowThing,
  completeScheduleTool,
  lendThing,
  openClaim,
  returnThing,
  snoozeScheduleTool,
  upcoming,
  updateClaimTool,
} from './handlers/household.js';
import { arrangeRoomsTool, getMapTool } from './handlers/map.js';
import {
  addBoxTool,
  getMoveTool,
  listMovesTool,
  packIntoBoxTool,
  setBoxStatusTool,
  startMoveTool,
  unpackBoxTool,
} from './handlers/moving.js';
import { turnIntoBoxesTool, updatePlaceTool } from './handlers/places.js';
import {
  capabilities,
  findDocuments,
  getThing,
  listContents,
  listLocations,
  searchThings,
  thingHistoryTool,
  whereIs,
} from './handlers/read.js';
import { logServiceTool } from './handlers/services.js';
import { listTags, tagThingsTool } from './handlers/tags.js';
import { logFuelTool } from './handlers/vehicles.js';
import {
  addThing,
  attachLink,
  changeLifecycleTool,
  createPlaceTool,
  logReading,
  markSeenTool,
  moveThing,
  removeInventoryRecord,
  updateThingTool,
} from './handlers/write.js';
import type { Handler, HandlerTable } from './types.js';

// The handlers, one per TOOL_DEFS entry whose service exists. A contract
// without a handler is never offered (`capabilities`, toolsFor()) and answers
// `tool_unavailable`. Step 4's services exist, so its tools are here; step 5's join with their
// services (log_service with schedules/services.ts, log_fuel with fuel/service.ts), step 7's
// adjust_stock with consumables/service.ts, and 1.x's Moving mode tools with moving/service.ts.

const HANDLERS: HandlerTable = {
  capabilities,
  list_locations: listLocations,
  search_things: searchThings,
  where_is: whereIs,
  get_thing: getThing,
  list_contents: listContents,
  thing_history: thingHistoryTool,
  find_documents: findDocuments,
  add_thing: addThing,
  update_thing: updateThingTool,
  remove_inventory_record: removeInventoryRecord,
  move_thing: moveThing,
  mark_seen: markSeenTool,
  // 1.x: a thing's lifecycle (sold, given away, put away, back in use), MCP only.
  change_lifecycle: changeLifecycleTool,
  create_place: createPlaceTool,
  // 1.x (#313): the place form and Turn places into boxes.
  update_place: updatePlaceTool,
  turn_into_boxes: turnIntoBoxesTool,
  // 1.x: the location map's rooms, MCP only.
  get_map: getMapTool,
  arrange_rooms: arrangeRoomsTool,
  attach_link: attachLink,
  log_reading: logReading,
  // Step 4's services (lending, schedules, warranties and claims, the agenda).
  upcoming,
  lend_thing: lendThing,
  return_thing: returnThing,
  borrow_thing: borrowThing,
  complete_schedule: completeScheduleTool,
  snooze_schedule: snoozeScheduleTool,
  add_warranty: addWarranty,
  open_claim: openClaim,
  update_claim: updateClaimTool,
  // Step 5's services (services, fuel).
  log_service: logServiceTool,
  log_fuel: logFuelTool,
  // Step 7's service (consumables).
  adjust_stock: adjustStockTool,
  // 1.x's Moving mode (D251), MCP only.
  list_moves: listMovesTool,
  get_move: getMoveTool,
  start_move: startMoveTool,
  add_box: addBoxTool,
  pack_into_box: packIntoBoxTool,
  set_box_status: setBoxStatusTool,
  unpack_box: unpackBoxTool,
  // 1.x (#209): tags, MCP only.
  list_tags: listTags,
  tag_things: tagThingsTool,
};

export function handlerOf<N extends ToolName>(name: N): Handler<N> | undefined {
  return HANDLERS[name] as Handler<N> | undefined;
}

/** The tools with a handler, in TOOL_DEFS order. */
export function handledTools(): ToolName[] {
  return Object.keys(HANDLERS) as ToolName[];
}
