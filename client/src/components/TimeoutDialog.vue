<script>
export default {
  name: 'TimeoutDialog',
  data: () => ({
    show: false,
  }),
  watch: {
    isAppIdle(idle) {
      if (idle) {
        this.show = true;
      }
    },
  },
};
</script>

<template>
  <v-dialog
    v-model="show"
    width="500"
  >
    <v-card>
      <v-card-title class="text-h5 grey lighten-2">
        Warning
      </v-card-title>

      <v-card-text>
        You have been inactive for more than 1 hour. Your session will
        automatically terminate in 5 minutes
      </v-card-text>

      <v-divider />

      <v-card-actions>
        <v-spacer />
        <v-btn
          color="primary"
          text
          @click="show = false"
        >
          I accept
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
