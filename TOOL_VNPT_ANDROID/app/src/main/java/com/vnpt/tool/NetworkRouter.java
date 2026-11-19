package com.vnpt.tool;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;

import java.io.IOException;

/**
 * Keeps Wi-Fi (local modem LAN, even without Internet) and cellular (VNPT Internet)
 * as separate Network objects. HTTP clients bind sockets to the selected Network.
 */
public final class NetworkRouter {
    private final ConnectivityManager connectivity;
    private volatile Network wifiNetwork;
    private volatile Network cellularNetwork;
    private boolean started;

    private final ConnectivityManager.NetworkCallback wifiCallback =
            new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) {
            wifiNetwork = network;
            synchronized (NetworkRouter.this) { NetworkRouter.this.notifyAll(); }
        }
        @Override public void onLost(Network network) {
            if (network.equals(wifiNetwork)) wifiNetwork = null;
            synchronized (NetworkRouter.this) { NetworkRouter.this.notifyAll(); }
        }
    };

    private final ConnectivityManager.NetworkCallback cellularCallback =
            new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) {
            cellularNetwork = network;
            synchronized (NetworkRouter.this) { NetworkRouter.this.notifyAll(); }
        }
        @Override public void onLost(Network network) {
            if (network.equals(cellularNetwork)) cellularNetwork = null;
            synchronized (NetworkRouter.this) { NetworkRouter.this.notifyAll(); }
        }
        @Override public void onUnavailable() {
            cellularNetwork = null;
            synchronized (NetworkRouter.this) { NetworkRouter.this.notifyAll(); }
        }
    };

    public NetworkRouter(Context context) {
        connectivity = (ConnectivityManager) context.getApplicationContext()
                .getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    /** Register Wi-Fi observation and explicitly request a cellular Internet network. */
    public synchronized void start() {
        if (started || connectivity == null) return;
        started = true;
        NetworkRequest wifiRequest = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                .build(); // Deliberately does NOT require NET_CAPABILITY_INTERNET.
        NetworkRequest cellularRequest = new NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build();
        try { connectivity.registerNetworkCallback(wifiRequest, wifiCallback); }
        catch (Exception ignored) { }
        try { connectivity.requestNetwork(cellularRequest, cellularCallback); }
        catch (Exception ignored) { }
        // Seed from the currently available networks in case callbacks raced startup.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            for (Network network : connectivity.getAllNetworks()) {
                NetworkCapabilities caps = connectivity.getNetworkCapabilities(network);
                if (caps == null) continue;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) wifiNetwork = network;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                        && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                    cellularNetwork = network;
                }
            }
        }
    }

    public Network awaitWifiNetwork() throws IOException {
        return await(true, 15000);
    }

    public Network awaitCellularNetwork() throws IOException {
        return await(false, 30000);
    }

    private Network await(boolean wifi, long timeoutMs) throws IOException {
        start();
        long deadline = System.currentTimeMillis() + timeoutMs;
        synchronized (this) {
            while (true) {
                Network found = wifi ? wifiNetwork : cellularNetwork;
                if (found != null) return found;
                long remaining = deadline - System.currentTimeMillis();
                if (remaining <= 0) break;
                try { wait(remaining); }
                catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IOException("Đã hủy chờ kết nối mạng", e);
                }
            }
        }
        throw new IOException(wifi
                ? "Không tìm thấy kết nối Wi-Fi modem. Hãy kết nối Wi-Fi modem trước."
                : "Không lấy được kết nối 4G. Hãy bật dữ liệu di động và kiểm tra SIM.");
    }

    public synchronized void close() {
        if (!started || connectivity == null) return;
        try { connectivity.unregisterNetworkCallback(wifiCallback); } catch (Exception ignored) { }
        try { connectivity.unregisterNetworkCallback(cellularCallback); } catch (Exception ignored) { }
        wifiNetwork = null;
        cellularNetwork = null;
        started = false;
    }
}
