/**
 * Location Tracking Module
 * Tracks user location using phone GPS via Zo API
 * Enables context-aware responses based on physical location
 */

export interface LocationData {
  latitude: number;
  longitude: number;
  accuracy: number; // meters
  timestamp: Date;
  altitude?: number; // meters
  heading?: number; // degrees
  speed?: number; // m/s
}

export interface RoomLocation {
  name: string;
  latitude: number;
  longitude: number;
  radius: number; // meters
}

export interface LocationContext {
  currentRoom: RoomLocation | null;
  coordinates: LocationData | null;
  nearbyRooms: RoomLocation[];
  homeDistance: number; // meters from home center
}

export class LocationTracker {
  private zoApiKey: string;
  private lastLocation: LocationData | null = null;
  private rooms: Map<string, RoomLocation> = new Map();
  private updateInterval: NodeJS.Timeout | null = null;
  private updateIntervalMs: number = 30000; // 30 seconds

  constructor(
    zoApiKey: string,
    rooms?: RoomLocation[]
  ) {
    if (!zoApiKey) {
      throw new Error(
        "ZO_API_KEY required for Location. Add to Settings > Advanced > Secrets"
      );
    }

    this.zoApiKey = zoApiKey;

    // Default rooms (adjust to your home layout)
    const defaultRooms: RoomLocation[] = rooms || [
      {
        name: "workshop",
        latitude: 49.88,
        longitude: -97.14,
        radius: 10,
      },
      { name: "office", latitude: 49.88, longitude: -97.14, radius: 8 },
      { name: "kitchen", latitude: 49.88, longitude: -97.14, radius: 8 },
      { name: "living room", latitude: 49.88, longitude: -97.14, radius: 10 },
      { name: "bedroom", latitude: 49.88, longitude: -97.14, radius: 8 },
    ];

    defaultRooms.forEach((room) => {
      this.rooms.set(room.name.toLowerCase(), room);
    });
  }

  /**
   * Get current location from phone via Zo API
   */
  async getCurrentLocation(): Promise<LocationData | null> {
    try {
      console.log("[Location] Fetching current location...");

      // TODO: Implement Zo API call to get phone GPS location
      // const response = await fetch("https://api.zo.computer/location/current", {
      //   headers: {
      //     Authorization: `Bearer ${this.zoApiKey}`,
      //   },
      // });
      //
      // if (response.ok) {
      //   const data = await response.json();
      //   this.lastLocation = {
      //     latitude: data.latitude,
      //     longitude: data.longitude,
      //     accuracy: data.accuracy,
      //     timestamp: new Date(data.timestamp),
      //     altitude: data.altitude,
      //     heading: data.heading,
      //     speed: data.speed,
      //   };
      //   return this.lastLocation;
      // }

      // Placeholder response
      console.log(
        "[Location] Placeholder location (connect phone to Zo for real GPS)"
      );
      return null;
    } catch (error) {
      console.error(
        `[Location] Failed to fetch location: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /**
   * Start continuous location tracking
   */
  startTracking(): void {
    console.log(
      `[Location] Tracking enabled (updates every ${this.updateIntervalMs}ms)`
    );

    this.updateInterval = setInterval(async () => {
      await this.getCurrentLocation();
    }, this.updateIntervalMs);
  }

  /**
   * Stop continuous location tracking
   */
  stopTracking(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      console.log("[Location] Tracking stopped");
    }
  }

  /**
   * Get current location context
   */
  async getLocationContext(): Promise<LocationContext> {
    const location = this.lastLocation || (await this.getCurrentLocation());

    if (!location) {
      return {
        currentRoom: null,
        coordinates: null,
        nearbyRooms: [],
        homeDistance: 0,
      };
    }

    // Find current room based on coordinates
    let currentRoom: RoomLocation | null = null;
    const nearbyRooms: RoomLocation[] = [];

    for (const room of this.rooms.values()) {
      const distance = this.calculateDistance(location, room);

      if (distance <= room.radius) {
        if (!currentRoom || distance < this.calculateDistance(location, currentRoom)) {
          if (currentRoom) {
            nearbyRooms.push(currentRoom);
          }
          currentRoom = room;
        } else {
          nearbyRooms.push(room);
        }
      } else {
        nearbyRooms.push(room);
      }
    }

    // Calculate distance from home (assuming home is at first room)
    const homeRoom = Array.from(this.rooms.values())[0];
    const homeDistance = this.calculateDistance(location, homeRoom);

    return {
      currentRoom,
      coordinates: location,
      nearbyRooms: nearbyRooms.slice(0, 3), // Top 3 nearby
      homeDistance,
    };
  }

  /**
   * Get room-specific context
   */
  async getRoomContext(): Promise<string> {
    const context = await this.getLocationContext();

    if (!context.currentRoom) {
      return "Location unknown. Enable phone GPS for context-aware responses.";
    }

    return `You are in the ${context.currentRoom.name}. ${
      context.nearbyRooms.length > 0
        ? `Nearby: ${context.nearbyRooms.map((r) => r.name).join(", ")}.`
        : ""
    }`;
  }

  /**
   * Add room to location database
   */
  addRoom(room: RoomLocation): void {
    this.rooms.set(room.name.toLowerCase(), room);
    console.log(
      `[Location] Added room: ${room.name} at (${room.latitude}, ${room.longitude})`
    );
  }

  /**
   * Remove room
   */
  removeRoom(roomName: string): void {
    this.rooms.delete(roomName.toLowerCase());
    console.log(`[Location] Removed room: ${roomName}`);
  }

  /**
   * Get all rooms
   */
  getRooms(): RoomLocation[] {
    return Array.from(this.rooms.values());
  }

  /**
   * Calculate distance between two coordinates (Haversine formula)
   */
  private calculateDistance(
    location: LocationData | RoomLocation,
    room: RoomLocation
  ): number {
    const R = 6371000; // Earth radius in meters
    const φ1 = (location.latitude * Math.PI) / 180;
    const φ2 = (room.latitude * Math.PI) / 180;
    const Δφ = ((room.latitude - location.latitude) * Math.PI) / 180;
    const Δλ = ((room.longitude - location.longitude) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distance = R * c;

    return distance;
  }

  /**
   * Check if user is at specific location
   */
  async isAt(roomName: string): Promise<boolean> {
    const context = await this.getLocationContext();

    if (!context.currentRoom) {
      return false;
    }

    return context.currentRoom.name.toLowerCase() === roomName.toLowerCase();
  }

  /**
   * Get last known location
   */
  getLastKnownLocation(): LocationData | null {
    return this.lastLocation;
  }
}
