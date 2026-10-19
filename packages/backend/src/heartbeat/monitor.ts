import { safeConsole } from '../services/safe-error-log.js';
/**
 * Heartbeat Monitor Service
 * Tracks component health and manages heartbeats
 */

import { backgroundEnabled } from '../config/background.js';
import { v4 as uuidv4 } from 'uuid';
import {
  type Heartbeat,
  type ComponentRegistration,
  type ComponentState,
  type HealthStatus,
  type SystemHealth,
  type Alert,
  type HeartbeatConfig,
  type ComponentType,
  DEFAULT_HEARTBEAT_CONFIG,
} from './types.js';

type StatusChangeHandler = (componentId: string, oldStatus: HealthStatus, newStatus: HealthStatus) => void;
type AlertHandler = (alert: Alert) => void;

export class HeartbeatMonitor {
  private config: HeartbeatConfig;
  private components: Map<string, ComponentState> = new Map();
  private heartbeatHistory: Map<string, Heartbeat[]> = new Map();
  private alerts: Alert[] = [];
  private checkIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();
  private statusHandlers: StatusChangeHandler[] = [];
  private alertHandlers: AlertHandler[] = [];
  private startTime: Date = new Date();

  constructor(config: Partial<HeartbeatConfig> = {}) {
    this.config = { ...DEFAULT_HEARTBEAT_CONFIG, ...config };
  }

  /**
   * Register a component for monitoring
   */
  register(registration: ComponentRegistration): ComponentState {
    const state: ComponentState = {
      registration,
      status: 'unknown',
      consecutiveFailures: 0,
      uptime24h: 100,
      avgResponseTime: 0,
      checking: false,
    };

    this.components.set(registration.id, state);
    this.heartbeatHistory.set(registration.id, []);

    safeConsole.log(`[Heartbeat] Registered component: ${registration.name} (${registration.id})`);

    // Start automatic health checks if configured
    if (this.config.autoCheck && registration.healthCheck) {
      this.startAutoCheck(registration.id);
    }

    return state;
  }

  /**
   * Unregister a component
   */
  unregister(componentId: string): boolean {
    this.stopAutoCheck(componentId);
    this.heartbeatHistory.delete(componentId);
    return this.components.delete(componentId);
  }

  /**
   * Record a heartbeat
   */
  recordHeartbeat(
    componentId: string,
    data: Partial<Omit<Heartbeat, 'id' | 'componentId' | 'timestamp'>> = {}
  ): Heartbeat | null {
    const state = this.components.get(componentId);
    if (!state) {
      safeConsole.warn(`[Heartbeat] Unknown component: ${componentId}`);
      return null;
    }

    const heartbeat: Heartbeat = {
      id: uuidv4(),
      componentId,
      componentType: state.registration.type,
      componentName: state.registration.name,
      status: data.status || 'healthy',
      timestamp: new Date(),
      responseTime: data.responseTime,
      cpuUsage: data.cpuUsage,
      memoryUsage: data.memoryUsage,
      metrics: data.metrics,
      error: data.error,
      metadata: data.metadata,
    };

    // Update state
    const oldStatus = state.status;
    state.lastHeartbeat = heartbeat;

    if (heartbeat.status === 'healthy') {
      state.lastSuccessful = heartbeat.timestamp;
      state.consecutiveFailures = 0;
    } else if (heartbeat.status === 'unhealthy') {
      state.consecutiveFailures++;
    }

    // Determine new status based on thresholds
    state.status = this.evaluateStatus(state, heartbeat);

    // Add to history
    this.addToHistory(componentId, heartbeat);

    // Calculate metrics
    this.updateMetrics(state);

    // Check for status change
    if (oldStatus !== state.status) {
      this.handleStatusChange(componentId, oldStatus, state.status);
    }

    return heartbeat;
  }

  /**
   * Evaluate component status based on heartbeat and thresholds
   */
  private evaluateStatus(state: ComponentState, heartbeat: Heartbeat): HealthStatus {
    const thresholds = state.registration.thresholds;

    // Check explicit status
    if (heartbeat.status === 'unhealthy') {
      return 'unhealthy';
    }

    // Check consecutive failures
    if (thresholds?.maxFailures && state.consecutiveFailures >= thresholds.maxFailures) {
      return 'unhealthy';
    }

    // Check response time
    if (thresholds?.maxResponseTime && heartbeat.responseTime) {
      if (heartbeat.responseTime > thresholds.maxResponseTime * 2) {
        return 'unhealthy';
      }
      if (heartbeat.responseTime > thresholds.maxResponseTime) {
        return 'degraded';
      }
    }

    // Check CPU usage
    if (thresholds?.maxCpuUsage && heartbeat.cpuUsage) {
      if (heartbeat.cpuUsage > 95) {
        return 'unhealthy';
      }
      if (heartbeat.cpuUsage > thresholds.maxCpuUsage) {
        return 'degraded';
      }
    }

    // Check memory usage
    if (thresholds?.maxMemoryUsage && heartbeat.memoryUsage) {
      if (heartbeat.memoryUsage > thresholds.maxMemoryUsage * 1.5) {
        return 'unhealthy';
      }
      if (heartbeat.memoryUsage > thresholds.maxMemoryUsage) {
        return 'degraded';
      }
    }

    return heartbeat.status;
  }

  /**
   * Add heartbeat to history
   */
  private addToHistory(componentId: string, heartbeat: Heartbeat): void {
    const history = this.heartbeatHistory.get(componentId);
    if (!history) return;

    history.push(heartbeat);

    // Trim history
    const maxEntries = this.config.maxHistoryEntries;
    if (history.length > maxEntries) {
      history.splice(0, history.length - maxEntries);
    }

    // Remove old entries
    const cutoff = Date.now() - this.config.historyRetention * 60 * 60 * 1000;
    const firstValidIndex = history.findIndex((h) => h.timestamp.getTime() > cutoff);
    if (firstValidIndex > 0) {
      history.splice(0, firstValidIndex);
    }
  }

  /**
   * Update component metrics
   */
  private updateMetrics(state: ComponentState): void {
    const history = this.heartbeatHistory.get(state.registration.id);
    if (!history || history.length === 0) return;

    // Calculate average response time (last 1 hour)
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentHeartbeats = history.filter((h) => h.timestamp.getTime() > oneHourAgo);

    if (recentHeartbeats.length > 0) {
      const responseTimes = recentHeartbeats
        .filter((h) => h.responseTime !== undefined)
        .map((h) => h.responseTime!);

      if (responseTimes.length > 0) {
        state.avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
      }
    }

    // Calculate uptime (last 24 hours)
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const dayHeartbeats = history.filter((h) => h.timestamp.getTime() > oneDayAgo);

    if (dayHeartbeats.length > 0) {
      const healthyCount = dayHeartbeats.filter((h) => h.status === 'healthy').length;
      state.uptime24h = (healthyCount / dayHeartbeats.length) * 100;
    }
  }

  /**
   * Handle status change
   */
  private handleStatusChange(
    componentId: string,
    oldStatus: HealthStatus,
    newStatus: HealthStatus
  ): void {
    const state = this.components.get(componentId);
    if (!state) return;

    safeConsole.log(
      `[Heartbeat] Status change: ${state.registration.name} ${oldStatus} -> ${newStatus}`
    );

    // Notify handlers
    for (const handler of this.statusHandlers) {
      try {
        handler(componentId, oldStatus, newStatus);
      } catch (error) {
        console.error('[Heartbeat] Status handler error:', error);
      }
    }

    // Create alert if needed
    if (this.config.alerts.enabled) {
      this.createAlertIfNeeded(state, oldStatus, newStatus);
    }
  }

  /**
   * Create alert if needed
   */
  private createAlertIfNeeded(
    state: ComponentState,
    oldStatus: HealthStatus,
    newStatus: HealthStatus
  ): void {
    // Determine severity
    let severity: 'warning' | 'critical' | null = null;

    if (newStatus === 'unhealthy') {
      severity = state.registration.critical ? 'critical' : 'warning';
    } else if (newStatus === 'degraded' && oldStatus === 'healthy') {
      severity = 'warning';
    }

    if (!severity) return;

    // Check minimum severity
    if (this.config.alerts.minSeverity === 'critical' && severity === 'warning') {
      return;
    }

    // Check cooldown
    const recentAlert = this.alerts.find(
      (a) =>
        a.componentId === state.registration.id &&
        !a.resolvedAt &&
        Date.now() - a.timestamp.getTime() < this.config.alerts.cooldown
    );

    if (recentAlert) return;

    // Create alert
    const alert: Alert = {
      id: uuidv4(),
      componentId: state.registration.id,
      componentName: state.registration.name,
      severity,
      message: `Component ${state.registration.name} is now ${newStatus}${
        state.lastHeartbeat?.error ? `: ${state.lastHeartbeat.error}` : ''
      }`,
      timestamp: new Date(),
      previousStatus: oldStatus,
      newStatus,
      notified: false,
    };

    this.alerts.push(alert);

    // Notify alert handlers
    for (const handler of this.alertHandlers) {
      try {
        handler(alert);
        alert.notified = true;
      } catch (error) {
        console.error('[Heartbeat] Alert handler error:', error);
      }
    }

    safeConsole.log(`[Heartbeat] Alert created: ${alert.severity} - ${alert.message}`);
  }

  /**
   * Resolve an alert
   */
  resolveAlert(alertId: string): boolean {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (alert && !alert.resolvedAt) {
      alert.resolvedAt = new Date();
      return true;
    }
    return false;
  }

  /**
   * Start automatic health checks
   */
  private startAutoCheck(componentId: string): void {
    const state = this.components.get(componentId);
    if (!state) return;
    // RUN-ISO F2: no check timers with AGENT_PLAYER_BACKGROUND=off.
    if (!backgroundEnabled()) return;

    const interval = state.registration.interval || this.config.defaultInterval;

    const checkFn = async () => {
      if (state.checking) return;
      state.checking = true;

      try {
        // This would be extended to actually perform health checks
        // For now, we just mark as needing external heartbeat
        const timeSinceLastHeartbeat = state.lastHeartbeat
          ? Date.now() - state.lastHeartbeat.timestamp.getTime()
          : Infinity;

        const timeout = state.registration.timeout || this.config.defaultTimeout;

        if (timeSinceLastHeartbeat > timeout * 2) {
          this.recordHeartbeat(componentId, {
            status: 'unhealthy',
            error: 'Heartbeat timeout - no response received',
          });
        } else if (timeSinceLastHeartbeat > timeout) {
          this.recordHeartbeat(componentId, {
            status: 'degraded',
            error: 'Heartbeat delayed',
          });
        }
      } finally {
        state.checking = false;
      }
    };

    const intervalId = setInterval(checkFn, interval);
    this.checkIntervals.set(componentId, intervalId);
  }

  /**
   * Stop automatic health checks
   */
  private stopAutoCheck(componentId: string): void {
    const intervalId = this.checkIntervals.get(componentId);
    if (intervalId) {
      clearInterval(intervalId);
      this.checkIntervals.delete(componentId);
    }
  }

  /**
   * Register status change handler
   */
  onStatusChange(handler: StatusChangeHandler): () => void {
    this.statusHandlers.push(handler);
    return () => {
      const index = this.statusHandlers.indexOf(handler);
      if (index > -1) this.statusHandlers.splice(index, 1);
    };
  }

  /**
   * Register alert handler
   */
  onAlert(handler: AlertHandler): () => void {
    this.alertHandlers.push(handler);
    return () => {
      const index = this.alertHandlers.indexOf(handler);
      if (index > -1) this.alertHandlers.splice(index, 1);
    };
  }

  /**
   * Get component state
   */
  getComponent(componentId: string): ComponentState | undefined {
    return this.components.get(componentId);
  }

  /**
   * Get all components
   */
  getAllComponents(): ComponentState[] {
    return Array.from(this.components.values());
  }

  /**
   * Get components by type
   */
  getComponentsByType(type: ComponentType): ComponentState[] {
    return this.getAllComponents().filter((c) => c.registration.type === type);
  }

  /**
   * Get component history
   */
  getHistory(componentId: string, limit?: number): Heartbeat[] {
    const history = this.heartbeatHistory.get(componentId) || [];
    if (limit) {
      return history.slice(-limit);
    }
    return [...history];
  }

  /**
   * Get system health summary
   */
  getSystemHealth(): SystemHealth {
    const components = this.getAllComponents();
    const healthyCount = components.filter((c) => c.status === 'healthy').length;
    const degradedCount = components.filter((c) => c.status === 'degraded').length;
    const unhealthyCount = components.filter((c) => c.status === 'unhealthy').length;
    const unknownCount = components.filter((c) => c.status === 'unknown').length;

    const criticalDown = components
      .filter((c) => c.registration.critical && c.status === 'unhealthy')
      .map((c) => c.registration.name);

    // Determine overall status
    let status: HealthStatus = 'healthy';
    if (criticalDown.length > 0) {
      status = 'unhealthy';
    } else if (unhealthyCount > 0 || degradedCount > components.length * 0.3) {
      status = 'degraded';
    } else if (unknownCount === components.length) {
      status = 'unknown';
    }

    const activeAlerts = this.alerts.filter((a) => !a.resolvedAt).length;

    return {
      status,
      totalComponents: components.length,
      healthyCount,
      degradedCount,
      unhealthyCount,
      unknownCount,
      criticalDown,
      lastCheck: new Date(),
      uptime: Date.now() - this.startTime.getTime(),
      activeAlerts,
    };
  }

  /**
   * Get active alerts
   */
  getActiveAlerts(): Alert[] {
    return this.alerts.filter((a) => !a.resolvedAt);
  }

  /**
   * Get all alerts
   */
  getAllAlerts(limit?: number): Alert[] {
    const sorted = [...this.alerts].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
    );
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /**
   * Get configuration
   */
  getConfig(): HeartbeatConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<HeartbeatConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Stop all monitoring
   */
  stop(): void {
    for (const componentId of this.checkIntervals.keys()) {
      this.stopAutoCheck(componentId);
    }
  }
}

// Singleton instance
let heartbeatMonitor: HeartbeatMonitor | null = null;

export function getHeartbeatMonitor(config?: Partial<HeartbeatConfig>): HeartbeatMonitor {
  if (!heartbeatMonitor) {
    heartbeatMonitor = new HeartbeatMonitor(config);
  }
  return heartbeatMonitor;
}
