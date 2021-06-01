<script>
import { mapGetters } from 'vuex';

export default {
  name: 'UserButton',
  inject: ['girderRest'],
  computed: {
    initials() {
      const first = this.girderRest.user.firstName;
      const last = this.girderRest.user.lastName;
      return (
        first.charAt(0).toLocaleUpperCase() + last.charAt(0).toLocaleUpperCase()
      );
    },
    ...mapGetters(['currentUser']),
  },
};
</script>

<template>
  <v-btn
    v-if="true"
    icon
    color="black lighten-1"
    class="mr-4"
    @click="$emit('user')"
  >
    Logout
  </v-btn>
  <v-btn
    v-else
    text
    @click="$emit('login')"
  >
    Login
  </v-btn>
</template>

<style lang="scss">
button.user-avatar-btn .v-btn__content {
  height: inherit;
}
</style>
