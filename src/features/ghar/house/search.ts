import type { GharDevice } from "../../../shared/api/types";
import { roomTitle } from "../commission";

/** A room panel on the Ghar page. */
export type RoomRef = { id: string; name: string };

/** What the Ghar page draws for one search query. */
export type HouseSearch = {
  /** Rooms to draw, in order, each with the devices to list in it. */
  rooms: Array<{ room: RoomRef; listed: GharDevice[] }>;
  /** Matching rooms plus matching devices; null while the query is empty. */
  matches: number | null;
  /** The only match when it is a device, for Enter to open its controls. */
  lonelyDevice: GharDevice | null;
};

/**
 * Narrow the page to a query. A room whose name matches keeps every device;
 * otherwise a room stays only for the devices whose name or product matches.
 */
export function searchHouse(query: string, rooms: RoomRef[], devices: GharDevice[]): HouseSearch {
  const needle = query.trim().toLowerCase();
  const inRoom = (room: RoomRef) => devices.filter((device) => device.room.id === room.id);
  if (!needle) {
    return {
      rooms: rooms.map((room) => ({ room, listed: inRoom(room) })),
      matches: null,
      lonelyDevice: null,
    };
  }
  const roomHit = (room: RoomRef) => roomTitle(room.name).toLowerCase().includes(needle);
  const deviceHit = (device: GharDevice) =>
    [device.name, device.product_name ?? ""].some((text) => text.toLowerCase().includes(needle));
  const matchedRooms = rooms.filter(roomHit);
  const matchedDevices = devices.filter(deviceHit);
  return {
    rooms: rooms.flatMap((room) => {
      const listed = roomHit(room) ? inRoom(room) : inRoom(room).filter(deviceHit);
      return roomHit(room) || listed.length > 0 ? [{ room, listed }] : [];
    }),
    matches: matchedRooms.length + matchedDevices.length,
    lonelyDevice:
      matchedRooms.length === 0 && matchedDevices.length === 1 ? matchedDevices[0]! : null,
  };
}
