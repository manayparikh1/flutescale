Scale Spot
Scale Spot is a browser utility that listens to your singing or playing and detects the scale (key / Sa). When it detects the tonic, you can enable a drone for that scale and compare yourself. The whole process happens in your browser  without any installations, uploading, and with your audio staying in your browser at all times.

I created this app because I play bansuri and maintaining Sa is crucial for me. This utility helps you warm up and maintain your pitch. In addition, it is useful for groups of people, such as bands and ensembles, since everybody can make sure they use the same scale.

Try it
Browsers don't allow to access microphones via file:// URLs, so you will have to start a tiny local server:

bash
cd flutescale
python3 -m http.server 8000
Afterwards visit http://localhost:8000.

Use it
🎤 START – play or sing for a few seconds, and it will detect the scale.

▶ SAMPLE buttons – try it right away using the built-in audio samples.

🎵 SA / SA + PA DRONE – keep the drone on the detected key for practice.

▶ PLAY FULL SCALE – listen to the whole scale up and down.

It features a tuner, tap-tempo metronome, A4 tuning modes, tips for practicing bansuri, dark theme, and the list of recent scale detections.

How it works

Scale Spot analyzes the chromagram (the energy of 12 pitch classes) recorded through the microphone or using sample audio and compares it to Krumhansl-Schmuckler key profiles to find the tonic note. The simple lock state mechanism prevents the result from jumping between the scales. Claude also helped me in making this by debugging small things along the way.
Why I Made This
I am a bansuri player, and I used to face the same issue repeatedly:
Occasionally, I wasn’t sure about the alignment of my Sa. In order to create something which:

Identifies the scale right away

Gives me a drone in that specific scale

Enables tuning

Does not require an internet connection and does not involve any setup time

Aids groups in maintaining the same scale

I created Scale Spot – a simple, yet musical application.


Who This Helps
Bansuri players checking Sa

Indian classical musicians practicing ragas

Western musicians checking keys

Bands and ensembles syncing their starting scale

Music teachers helping students tune quickly

Beginners who want a simple way to know what key they’re in

Pro musicians

**The reason why I created this application named Scale Spot is because I needed something simple to assist myself in tuning up my bansuri while playing and to make our practices as a group easy.**