package dk.mix.pixelagents.viewer.net;

/** Where decoded frames go. Implemented by the SurfaceView on the device, by a checker in tests. */
public interface FrameSink {
    /** The screen size to announce in HELLO. */
    int screenWidth();
    int screenHeight();

    /** CONFIG arrived: allocate for this frame size. Called again if the host changes it mid-session. */
    void configure(int width, int height);

    /** A full frame, tightly packed RGB565 little-endian, width*height*2 bytes valid. */
    void presentFull(byte[] rgb565, int length);

    /** One line of status for the overlay, about once a second. */
    void status(String line);
}
