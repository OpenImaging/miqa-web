<script>
import { mapGetters } from 'vuex';

export default {
  name: 'SessionTimer',
  computed: {
    ...mapGetters(['remainingSessionTime']),
    showTimeRemaining() {
      const remaining = this.remainingSessionTime;
      return remaining > 0 && remaining < 300;
    },
    timeRemaining() {
      const secondsRemaining = this.remainingSessionTime;
      const minutesRemaining = Math.ceil(secondsRemaining / 60.0);
      const what = minutesRemaining > 1 ? 'minutes' : 'minute';
      return `Session will expire in under ${minutesRemaining} ${what}`;
    },
  },
};
</script>

<template>
  <v-text-field
    v-show="showTimeRemaining"
    class="mt-6 warning-text"
    readonly
    flat
    dense
    solo
    background-color="transparent"
    :value="timeRemaining"
  />
</template>

<style lang="scss">
.warning-text {
  font-size: 1.1em;
  font-weight: bold;
}
</style>
